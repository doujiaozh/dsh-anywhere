/**
 * aw_ffmpeg · api.ts — the three jobs everyone needs, plus probing.
 *
 *   transcode()     — remux/re-encode any container ffmpeg.wasm supports
 *   extractAudio()  — strip the soundtrack (mp3 / wav / aac / opus)
 *   captureFrame()  — poster frames at a timestamp
 *   probe()         — duration & stream info straight from ffmpeg's stderr
 *
 * All of them are sugar over the same in-memory engine: bytes in → bytes out,
 * zero temp files on the host, zero native code anywhere.
 */

import { FfmpegEngine, FfmpegEngineOptions, ProgressInfo } from './engine';

export interface MediaFile {
  name: string;
  data: Uint8Array | ArrayBuffer;
}

export type AudioFormat = 'mp3' | 'wav' | 'aac' | 'opus' | 'ogg' | 'flac';
export type FrameFormat = 'png' | 'mjpeg' | 'bmp';

export interface MediaProbe {
  duration: number | null;
  durationText: string | null;
  bitrateKbps: number | null;
  streams: {
    index: number;
    type: 'video' | 'audio' | 'subtitle' | 'other';
    codec: string;
    width?: number;
    height?: number;
    raw: string;
  }[];
  rawLog: string[];
}

export class AwFfmpeg {
  public readonly engine: FfmpegEngine;

  constructor(engineOrOptions?: FfmpegEngine | FfmpegEngineOptions) {
    this.engine =
      engineOrOptions instanceof FfmpegEngine
        ? engineOrOptions
        : new FfmpegEngine(engineOrOptions || {});
  }

  public onProgress(fn: (p: ProgressInfo) => void): () => void {
    return this.engine.events.on('progress', fn);
  }

  public onLog(fn: (line: string) => void): () => void {
    return this.engine.events.on('log', fn);
  }

  /** Raw ffmpeg argv — your escape hatch. Input/output bytes move with
   *  writeFile/readFile, e.g. `ffmpeg().run(['-i','in.mp4','-vf','scale=640:-1','out.mp4'])`. */
  public async run(args: string[]): Promise<number> {
    await this.engine.ensureLoaded();
    return this.engine.run(args);
  }

  public async writeFile(name: string, data: Uint8Array | ArrayBuffer): Promise<void> {
    await this.engine.ensureLoaded();
    this.engine.writeFile(name, data);
  }

  public async readFile(name: string): Promise<Uint8Array> {
    await this.engine.ensureLoaded();
    return this.engine.readFile(name);
  }

  /**
   * Transcode `input` into `outputName`. Pass extra argv to override the
   * default `libx264 + aac` preset (`-crf`, `-preset`, `-vf`, …).
   */
  public async transcode(
    input: MediaFile,
    outputName?: string,
    extraArgs?: string[]
  ): Promise<MediaFile> {
    await this.engine.ensureLoaded();
    const out = outputName || deriveName(input.name, '_out');
    await this.stageInput(input);
    const args = ['-i', input.name].concat(extraArgs || [], [out]);
    await this.runAndCheck(args, out);
    return this.collect(out);
  }

  /** Pull the audio track out of a media file. */
  public async extractAudio(
    input: MediaFile,
    format: AudioFormat = 'mp3',
    extraArgs?: string[]
  ): Promise<MediaFile> {
    await this.engine.ensureLoaded();
    const out = deriveName(input.name, '_audio', '.' + format);
    await this.stageInput(input);

    const codecArgs: string[] = ['-vn'];
    if (format === 'mp3') codecArgs.push('-c:a', 'libmp3lame', '-q:a', '2');
    else if (format === 'wav') codecArgs.push('-c:a', 'pcm_s16le');
    else if (format === 'aac') codecArgs.push('-c:a', 'aac', '-b:a', '192k');
    else if (format === 'opus') codecArgs.push('-c:a', 'libopus', '-b:a', '96k');
    else if (format === 'ogg') codecArgs.push('-c:a', 'libvorbis', '-q:a', '4');
    else if (format === 'flac') codecArgs.push('-c:a', 'flac');

    const args = ['-i', input.name].concat(codecArgs, extraArgs || [], [out]);
    await this.runAndCheck(args, out);
    return this.collect(out);
  }

  /**
   * Grab one (or `frames`) still image at timestamp `at`
   * (`5`, `12.5`, `'00:00:03.2'` all accepted).
   */
  public async captureFrame(
    input: MediaFile,
    at: number | string = 0,
    format: FrameFormat = 'png',
    opts: { frames?: number; quality?: number; extraArgs?: string[] } = {}
  ): Promise<MediaFile> {
    await this.engine.ensureLoaded();
    const ext = format === 'mjpeg' ? '.jpg' : '.' + format;
    const out = deriveName(input.name, '_frame', ext);
    await this.stageInput(input);

    const ts = typeof at === 'number' ? formatTimestamp(at) : at;
    const n = opts.frames || 1;
    const q = opts.quality === undefined ? 2 : opts.quality;
    const args = [
      '-ss', ts,
      '-i', input.name,
      '-frames:v', String(n),
      '-q:v', String(q),
    ].concat(opts.extraArgs || [], [out]);
    await this.runAndCheck(args, out);
    return this.collect(out);
  }

  /** Duration, bitrate and stream inventory — no ffmpeg required on host. */
  public async probe(input: MediaFile): Promise<MediaProbe> {
    await this.engine.ensureLoaded();
    await this.stageInput(input);
    const log: string[] = [];
    const off = this.engine.events.on('log', (line) => log.push(line));
    // `-i` with no output makes ffmpeg print the header and exit(1) — expected.
    await this.engine.runRaw(['-i', input.name]);
    off();
    return parseProbeLog(log);
  }

  public dispose(): void {
    this.engine.dispose();
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async stageInput(input: MediaFile): Promise<void> {
    this.engine.writeFile(input.name, input.data);
  }

  private async runAndCheck(args: string[], outName: string): Promise<void> {
    // Progress lives on stderr; the engine's boot sinks already route it there.
    const code = await this.engine.run(args);
    this.engine.deleteFile(args[args.indexOf('-i') + 1] || '');
    if (code !== 0) {
      throw new Error('ffmpeg exited with code ' + code + ' for argv ' + JSON.stringify(args));
    }
    const present = this.engine.listFiles('/').indexOf(outName) >= 0;
    if (!present) {
      throw new Error('ffmpeg produced no output file ' + outName + ' (exit 0)');
    }
  }

  private collect(name: string): MediaFile {
    const data = this.engine.readFile(name);
    this.engine.deleteFile(name);
    return { name, data };
  }
}

/** Ready-to-use engine singleton helper (lazy boots on first call). */
let _default: AwFfmpeg | null = null;
export function ffmpeg(options?: FfmpegEngineOptions): AwFfmpeg {
  if (!_default || options) _default = new AwFfmpeg(options);
  return _default;
}

// ── parsing helpers ─────────────────────────────────────────────────────────

function deriveName(name: string, suffix: string, overrideExt?: string): string {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = overrideExt || (dot > 0 ? name.slice(dot) : '');
  return stripDir(base) + suffix + ext;
}

function stripDir(name: string): string {
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  return slash >= 0 ? name.slice(slash + 1) : name;
}

function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => (n < 10 ? '0' + n : '' + n);
  return pad(h) + ':' + pad(m) + ':' + pad(s);
}

export function parseProbeLog(log: string[]): MediaProbe {
  const probe: MediaProbe = { duration: null, durationText: null, bitrateKbps: null, streams: [], rawLog: log };
  for (const line of log) {
    const dur = line.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
    if (dur && probe.duration === null) {
      probe.durationText = dur[1] + ':' + dur[2] + ':' + dur[3];
      probe.duration = parseInt(dur[1], 10) * 3600 + parseInt(dur[2], 10) * 60 + parseFloat(dur[3]);
      const br = line.match(/bitrate:\s*(\d+)\s*kb\/s/);
      if (br) probe.bitrateKbps = parseInt(br[1], 10);
    }
    const st = line.match(/Stream\s+#(\d+:\d+)(?:\((\w+)\))?:\s*(Video|Audio|Subtitle):\s*(.*)/);
    if (st) {
      const type = st[3].toLowerCase() as 'video' | 'audio' | 'subtitle';
      const rest = st[4] || '';
      const dims = rest.match(/\b(\d{2,5})x(\d{2,5})\b/);
      probe.streams.push({
        index: probe.streams.length,
        type: type === 'video' || type === 'audio' || type === 'subtitle' ? type : 'other',
        codec: rest.split(',')[0].trim(),
        width: dims ? parseInt(dims[1], 10) : undefined,
        height: dims ? parseInt(dims[2], 10) : undefined,
        raw: line.trim(),
      });
    }
  }
  return probe;
}
