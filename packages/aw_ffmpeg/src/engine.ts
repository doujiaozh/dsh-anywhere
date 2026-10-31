/**
 * aw_ffmpeg · engine.ts — a booted ffmpeg.wasm core with a virtual FS and
 * progress-aware exec.
 */

import { bootFfmpegCore, BootOptions, CoreModule, CoreSource, DEFAULT_FFMPEG_CORE_URL } from './core-loader';

export interface FfmpegEngineOptions extends BootOptions {
  core?: CoreSource;
}

export interface ProgressInfo {
  /** Current position in the output, seconds. */
  time: number;
  /** time as ffmpeg prints it, e.g. `00:00:05.00`. */
  timecode: string;
  frame: number;
  fps: number;
  speed: number;
  /** Processed output size in KiB (when reported). */
  sizeKiB: number;
  raw: string;
}

type Listener<T> = (payload: T) => void;

/** Minimal typed emitter — no eventemitter3, no node dependency assumption. */
class Emitter<Events extends Record<string, any>> {
  private map: Map<keyof Events, Set<Listener<any>>> = new Map();
  on<K extends keyof Events>(event: K, fn: Listener<Events[K]>): () => void {
    let set = this.map.get(event);
    if (!set) {
      set = new Set();
      this.map.set(event, set);
    }
    set.add(fn);
    return () => {
      const s = this.map.get(event);
      if (s) s.delete(fn);
    };
  }
  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.map.get(event);
    if (set) for (const fn of set) fn(payload);
  }
}

export interface FfmpegEvents {
  log: string;
  progress: ProgressInfo;
  runStart: string[];
  runEnd: { args: string[]; exitCode: number };
}

export class FfmpegEngine {
  public readonly events = new Emitter<FfmpegEvents>();
  private core: CoreModule | null = null;
  private options: FfmpegEngineOptions;
  private loading: Promise<void> | null = null;

  constructor(options: FfmpegEngineOptions = {}) {
    const userLog = options.log || (() => undefined);
    const userStdout = options.stdout || userLog;
    const userStderr = options.stderr || userLog;

    // Route glue print streams through our emitter so consumers get `log`
    // lines and parsed `progress` updates from one place.
    const dispatch = (line: string): void => {
      if (!line) return;
      this.events.emit('log', line);
      const p = FfmpegEngine.parseProgress(line);
      if (p) this.events.emit('progress', p);
    };
    const sinkFor = (orig: (s: string) => void) => (chunk: string) => {
      orig(String(chunk));
      String(chunk)
        .split(/\r\n|\r|\n/)
        .forEach(dispatch);
    };

    this.options = {
      core: options.core || {},
      log: userLog,
      stdout: sinkFor(userStdout),
      stderr: sinkFor(userStderr),
    };
  }

  /** Boot the core once; subsequent calls share the same instance. */
  public ensureLoaded(): Promise<void> {
    if (this.core) return Promise.resolve();
    if (!this.loading) {
      this.loading = bootFfmpegCore(this.options).then((core) => {
        this.core = core;
      });
    }
    return this.loading;
  }

  get isLoaded(): boolean {
    return this.core !== null;
  }

  /** Write bytes into the core's virtual filesystem (MEMFS). */
  public writeFile(name: string, data: Uint8Array | ArrayBuffer): void {
    const fs = this.fs('writeFile');
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    fs('writeFile', name, bytes, { encoding: 'binary' });
  }

  /** Read a file out of the virtual filesystem. */
  public readFile(name: string): Uint8Array {
    const fs = this.fs('readFile');
    return fs('readFile', name, { encoding: 'binary' });
  }

  /** Remove a file from the virtual filesystem. */
  public deleteFile(name: string): void {
    try {
      this.fs('unlink')('unlink', name);
    } catch (_e) {
      /* best effort cleanup */
    }
  }

  /** List a virtual directory. */
  public listFiles(dir: string = '/'): string[] {
    try {
      return this.fs('readdir')('readdir', dir);
    } catch (_e) {
      return [];
    }
  }

  /**
   * Run a raw ffmpeg command. `-y` is prepended so overwriting the output in
   * the virtual FS never fails the job.
   * @returns ffmpeg's exit code
   */
  public run(args: string[]): Promise<number> {
    return this.execRaw(['-y'].concat(args));
  }

  /** Run a raw argv exactly as given (no implicit `-y`). */
  public runRaw(args: string[]): Promise<number> {
    return this.execRaw(args);
  }

  public dispose(): void {
    // The wasm core has no persistent host resources besides memory; drop it.
    this.core = null;
    this.loading = null;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private fs(opName: string): (op: string, ...rest: any[]) => any {
    if (!this.core) throw new Error('FfmpegEngine not loaded — call ensureLoaded() first');
    const fs = (this.core as any).FS;
    if (!fs || typeof fs !== 'function') {
      throw new Error('ffmpeg.wasm core has no Emscripten FS (op ' + opName + ')');
    }
    return fs;
  }

  private execRaw(args: string[]): Promise<number> {
    if (!this.core) {
      return Promise.reject(new Error('FfmpegEngine not loaded — call ensureLoaded() first'));
    }
    const core = this.core;
    this.events.emit('runStart', args);
    return new Promise<number>((resolve) => {
      // ffmpeg exits via its own exit() wired by the glue; callMain throws.
      let exitCode = 0;
      try {
        exitCode = core.callMain(args.slice());
      } catch (err) {
        // Emscripten quirk: exit() surfaces as an exception in many builds.
        const e = err as any;
        if (e && typeof e.status === 'number' && e.name === 'ExitStatus') {
          exitCode = e.status;
        } else if (e && typeof e.message === 'string' && /Exit Status|exit\(/.test(e.message)) {
          const parsed = e.message.match(/Exit Status:?\s*(-?\d+)/);
          exitCode = parsed ? parseInt(parsed[1], 10) : 0;
        } else {
          throw err;
        }
      }
      this.events.emit('runEnd', { args, exitCode });
      resolve(exitCode);
    });
  }

  /** Parse an ffmpeg progress line; null when the line carries none. */
  public static parseProgress(line: string): ProgressInfo | null {
    const m = line.match(/frame=\s*(\d+)/);
    const t = line.match(/time=\s*(\d+):(\d+):([\d.]+)/);
    if (!t) return null;
    const fpsM = line.match(/fps=\s*([\d.]+)/);
    const speedM = line.match(/speed=\s*([\d.]+)/);
    const sizeM = line.match(/size=\s*(\d+)kB/);
    const timecode = t[1] + ':' + t[2] + ':' + t[3];
    const time = parseInt(t[1], 10) * 3600 + parseInt(t[2], 10) * 60 + parseFloat(t[3]);
    return {
      time,
      timecode,
      frame: m ? parseInt(m[1], 10) : -1,
      fps: fpsM ? parseFloat(fpsM[1]) : -1,
      speed: speedM ? parseFloat(speedM[1]) : 1,
      sizeKiB: sizeM ? parseInt(sizeM[1], 10) : -1,
      raw: line,
    };
  }
}

export { DEFAULT_FFMPEG_CORE_URL };
