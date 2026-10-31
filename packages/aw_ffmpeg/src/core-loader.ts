/**
 * aw_ffmpeg · core-loader.ts — locate, fetch and boot `@ffmpeg/core` glue.
 *
 * The ffmpeg core is *pure data + pure WASM*: a UMD JS glue and a .wasm
 * sidecar. Nothing is compiled on the host — Win7, Linux, or a browser, the
 * boot sequence is identical:
 *
 *   1. resolve the glue JS (npm pkg | local path | CDN URL)
 *   2. obtain its `createFFmpegCore` factory (require in Node, <script> in browser)
 *   3. run the factory with our print/locateFile overrides → live Module
 */

import { isBrowser, isNode, loadBytes, nodeFs, nodePath, nodeRequire } from '@anywhere/core';

/** Where the public CDN mirror of the single-threaded core lives by default. */
export const DEFAULT_FFMPEG_CORE_URL = 'https://unpkg.com/@ffmpeg/core@0.11.1/dist/ffmpeg-core.js';

export interface CoreSource {
  /**
   * One of:
   *   - absolute or relative filesystem path to `ffmpeg-core.js` (Node)
   *   - http(s) URL of `ffmpeg-core.js`
   *   - `'npm'` — use the installed `@ffmpeg/core` package
   */
  jsPath?: string;
  /** Override for the .wasm sidecar location (else resolved next to the JS). */
  wasmPath?: string;
}

export interface CoreModule extends Record<string, any> {
  callMain: (args: string[]) => number;
  FS: any;
  ccall: (fn: string, rt: string, at: string[], av: any[]) => any;
  cwrap: (fn: string, rt: string, at: string[]) => (...a: any[]) => any;
  _main?: (argc: number, argv: number) => number;
}

export interface BootOptions {
  core?: CoreSource;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  log?: (line: string) => void;
}

interface GlueFactory {
  (overrides: Record<string, any>): Promise<CoreModule> | CoreModule;
}

const cache = new Map<string, Promise<GlueFactory>>();

/**
 * Turn a glue-JS location into a callable `createFFmpegCore` factory,
 * caching per-location. In Node the text is written to a temp file and
 * `require()`d (no eval of remote strings without a file on disk); in the
 * browser it is injected as a `<script>` once.
 */
export function loadCoreFactory(source: CoreSource = {}): Promise<GlueFactory> {
  const key = JSON.stringify({ p: source.jsPath || 'npm' });
  const hit = cache.get(key);
  if (hit) return hit;

  const promise = (async (): Promise<GlueFactory> => {
    if (!source.jsPath || source.jsPath === 'npm') {
      const pkg = nodeRequire('@ffmpeg/core');
      if (pkg && typeof pkg === 'function') return pkg as GlueFactory;
      if (pkg && typeof pkg.default === 'function') return pkg.default as GlueFactory;
      if (pkg && typeof pkg.createFFmpegCore === 'function') return pkg.createFFmpegCore;
      throw missingCoreError(source);
    }

    const jsPath = source.jsPath;
    if (isNode()) {
      const fs = nodeFs();
      const path = nodePath();
      if (fs === null || path === null) throw missingCoreError(source);
      let local = jsPath;
      if (/^https?:\/\//i.test(jsPath)) {
        const bytes = await loadBytes(jsPath);
        const os = nodeRequire('os');
        const tmp = path.join(os.tmpdir(), 'anywhere-ffmpeg-core.js');
        fs.writeFileSync(tmp, bytes);
        local = tmp;
      } else if (!path.isAbsolute(local)) {
        local = path.resolve(process.cwd(), local);
      }
      // Cache-bust require so a re-downloaded core is actually re-loaded.
      const resolved = requireResolve(local);
      const mod = requireModule(resolved);
      const factory: any =
        (mod && (mod.createFFmpegCore || mod.default)) ||
        (globalThis as any).createFFmpegCore;
      if (typeof factory !== 'function') {
        throw new Error('ffmpeg-core glue at ' + jsPath + ' did not expose createFFmpegCore');
      }
      return factory as GlueFactory;
    }

    if (isBrowser()) {
      await injectBrowserScript(jsPath);
      const factory = (globalThis as any).createFFmpegCore;
      if (typeof factory !== 'function') {
        throw new Error('Browser ffmpeg-core glue at ' + jsPath + ' did not define createFFmpegCore');
      }
      return factory as GlueFactory;
    }

    throw missingCoreError(source);
  })();

  cache.set(key, promise);
  return promise;
}

function requireResolve(file: string): string {
  // tslint:disable-next-line no-eval
  const fn = new Function('f', 'return eval("require").resolve(f)') as (f: string) => string;
  return fn(file);
}

function requireModule(resolved: string): any {
  // tslint:disable-next-line no-eval
  const fn = new Function('r', 'return eval("require")(r)') as (r: string) => any;
  return fn(resolved);
}

function injectBrowserScript(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = (globalThis as any).document;
    if (!doc) return reject(new Error('No document to inject a script into'));
    const el = doc.createElement('script');
    el.src = url;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error('Failed to load ' + url));
    doc.head.appendChild(el);
  });
}

function missingCoreError(source: CoreSource): Error {
  const where = source.jsPath ? ' (' + source.jsPath + ')' : ' via npm `@ffmpeg/core`';
  return new Error(
    'Anywhere: ffmpeg.wasm core not found' + where + '.\n' +
    '  Install it:      npm i @ffmpeg/core\n' +
    '  Or point at one: anywhere({ core: { jsPath: "' + DEFAULT_FFMPEG_CORE_URL + '" } })\n' +
    'The core ships no native code — it is a pure WASM download.'
  );
}

/** Boot the core module with the given sinks; the promise resolves when ready. */
export async function bootFfmpegCore(options: BootOptions = {}): Promise<CoreModule> {
  const factory = await loadCoreFactory(options.core || {});
  const stderr = options.stderr || options.log || (() => undefined);
  const stdout = options.stdout || options.log || (() => undefined);
  const debug = options.log || (() => undefined);

  const coreSource = options.core || {};
  const jsPath = coreSource.jsPath && coreSource.jsPath !== 'npm' ? coreSource.jsPath : '';
  const baseDir = jsPath ? jsPath.replace(/\/[^/]*$/, '/') : '';

  const overrides: Record<string, any> = {
    print: (s: string) => stdout(String(s)),
    printErr: (s: string) => stderr(String(s)),
    arguments: [],
    noInitialRun: true,
    locateFile: (name: string) => {
      if (coreSource.wasmPath) return coreSource.wasmPath;
      if (name.endsWith('.wasm') && jsPath && !/^https?:\/\//i.test(jsPath) && isNode()) {
        const path = nodePath();
        if (path) return path.join(path.resolve(process.cwd(), path.dirname(jsPath)), name);
      }
      return baseDir + name;
    },
  };

  const mod: CoreModule = await factory(overrides);
  if (!mod || typeof mod.callMain !== 'function') {
    throw new Error('ffmpeg.wasm core booted but has no callMain() — wrong/unsupported core build');
  }
  debug('ffmpeg.wasm core ready (no native compilation anywhere)');
  return mod;
}
