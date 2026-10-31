/**
 * aw_python · runtime.ts — boot CPython-in-WASM (Pyodide) on any host.
 *
 * Pyodide is CPython compiled to WASM; loading it is pure I/O: fetch the JS
 * glue, hand it an `indexURL` for the python.wasm wheel payloads, and speak
 * to the resulting interpreter. No CPython build, no pip dance, no native
 * extension compilation — numpy and pandas arrive as prebuilt wasm wheels.
 */

import { isNode, loadBytes, nodeFs, nodePath, nodeRequire } from '@anywhere/core';

/** Pinned, single-threaded Pyodide release (no pthreads — low-spec friendly). */
export const PYODIDE_VERSION = '0.26.4';

/** Default CDN index: where python.wasm + stdlib + wheels are fetched from. */
export const PYODIDE_CDN_INDEX = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

export interface PyodideSourceOptions {
  /**
   * Where to find the Pyodide distribution:
   *   - `'cdn'`        → jsDelivr CDN (default)
   *   - `'npm'`        → the installed `pyodide` npm package (Node only)
   *   - url/path string → indexURL that contains pyodide.js (+ .wasm payloads)
   *   - { indexURL }   → explicit
   */
  source?: 'cdn' | 'npm' | string | { indexURL: string };
  /** URLs of packages to preload (numpy/pandas handled automatically). */
  packages?: string[];
  /** stdout/stderr sinks for the interpreter. */
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /** Extra config passed to `loadPyodide()`. */
  config?: Record<string, any>;
}

export interface PyodideInterface {
  runPythonAsync(code: string): Promise<any>;
  runPython(code: string): any;
  globals: any;
  loadPackagesFromImports(code: string, opts?: any): Promise<void>;
  loadPackage(names: string | string[], opts?: any): Promise<void>;
  micropip: { install(names: string | string[], opts?: any): Promise<void> };
  registerJsModule(name: string, mod: any): void;
  toPy(value: any, options?: any): any;
  unpackArchive?(...args: any[]): any;
  version: string;
}

export class PyodideRuntime {
  public readonly pyodide: PyodideInterface;
  public readonly indexURL: string;

  constructor(pyodide: PyodideInterface, indexURL: string) {
    this.pyodide = pyodide;
    this.indexURL = indexURL;
  }

  /** Shortcut constructor: boot with options. */
  public static async create(options: PyodideSourceOptions = {}): Promise<PyodideRuntime> {
    const indexURL = resolveIndexURL(options.source);
    const loadPyodide = await obtainLoadPyodide(options.source, indexURL);
    const stdout = options.stdout || ((s: string) => console.log(s));
    const stderr = options.stderr || ((s: string) => console.error(s));

    const pyodide: PyodideInterface = await loadPyodide(
      Object.assign(
        {
          indexURL,
          stdout,
          stderr,
          fullStdLib: false,
        },
        options.config || {}
      )
    );

    const runtime = new PyodideRuntime(pyodide, indexURL);
    if (options.packages && options.packages.length) {
      await pyodide.loadPackage(options.packages);
    }
    return runtime;
  }

  /** Run arbitrary Python; awaitable across awaits inside the script. */
  public run(code: string): Promise<any> {
    return this.pyodide.runPythonAsync(code);
  }

  /** Load packages by name (numpy, pandas, …). */
  public async loadPackages(names: string | string[]): Promise<void> {
    await this.pyodide.loadPackage(names);
  }

  /** Auto-install everything the script imports (`import numpy as np`, …). */
  public async loadForScript(code: string): Promise<void> {
    await this.pyodide.loadPackagesFromImports(code);
  }

  /** Install a pure-Python wheel from PyPI via micropip. */
  public async pipInstall(names: string | string[]): Promise<void> {
    await this.pyodide.micropip.install(names);
  }

  /** Register a JS object as an importable Python module. */
  public registerJsModule(name: string, mod: any): void {
    this.pyodide.registerJsModule(name, mod);
  }

  /** True when `name` is importable and already loaded. */
  public async hasPackage(name: string): Promise<boolean> {
    const code = `import importlib\nimportlib.util.find_spec(${JSON.stringify(name)}) is not None`;
    try {
      return !!(await this.pyodide.runPythonAsync(code));
    } catch (_e) {
      return false;
    }
  }

  /** Interpreter version banner. */
  public banner(): string {
    return 'Anywhere Python (Pyodide ' + (this.pyodide.version || PYODIDE_VERSION) + ')';
  }
}

/** Resolve the indexURL a Pyodide distribution lives at. */
export function resolveIndexURL(source?: PyodideSourceOptions['source']): string {
  if (!source || source === 'cdn') return PYODIDE_CDN_INDEX;
  if (typeof source === 'string') {
    // A path like D:\pyodide or /srv/pyodide → indexURL must end with '/'.
    if (/^https?:\/\//i.test(source)) return source.endsWith('/') ? source : source + '/';
    const sep = source.endsWith('/') || source.endsWith('\\') ? '' : '/';
    return source + sep;
  }
  return source.indexURL;
}

type LoadPyodideFn = (config: Record<string, any>) => Promise<PyodideInterface>;

const _factoryCache = new Map<string, Promise<LoadPyodideFn>>();

async function obtainLoadPyodide(
  source: PyodideSourceOptions['source'],
  indexURL: string
): Promise<LoadPyodideFn> {
  const key = String(source || 'cdn');
  const hit = _factoryCache.get(key);
  if (hit) return hit;

  const promise = (async (): Promise<LoadPyodideFn> => {
    if (source === 'npm') {
      const pkg: any = nodeRequire('pyodide');
      const fn: any = pkg ? pkg.loadPyodide || pkg.default : null;
      if (typeof fn === 'function') return fn;
      throw new Error(
        'Anywhere: npm `pyodide` package not usable here. Install it (npm i pyodide) or use source:"cdn".'
      );
    }

    const jsUrl = indexURL.endsWith('/') ? indexURL + 'pyodide.js' : indexURL + '/pyodide.js';

    if (isNode()) {
      const fs = nodeFs();
      const path = nodePath();
      if (fs === null || path === null) throw new Error('Node fs/path unavailable');
      const bytes = await loadBytes(jsUrl);
      const os = nodeRequire('os');
      const tmp = path.join(os.tmpdir(), 'anywhere-pyodide-' + PYODIDE_VERSION + '.js');
      fs.writeFileSync(tmp, bytes);
      // tslint:disable-next-line no-eval
      const req = new Function('f', 'return eval("require")(f)') as (f: string) => any;
      const mod = req(tmp);
      const loadPyodide: any =
        (mod && (mod.loadPyodide || mod.default)) || (globalThis as any).loadPyodide;
      if (typeof loadPyodide !== 'function') {
        throw new Error('Pyodide glue at ' + jsUrl + ' did not expose loadPyodide()');
      }
      return loadPyodide;
    }

    // Browser: inject the glue script once, then grab the global.
    await new Promise<void>((resolve, reject) => {
      const g: any = globalThis;
      const doc = g.document;
      if (!doc) return reject(new Error('No document to load pyodide.js into'));
      const el = doc.createElement('script');
      el.src = jsUrl;
      el.onload = () => resolve();
      el.onerror = () => reject(new Error('Failed to load ' + jsUrl));
      doc.head.appendChild(el);
    });
    const loadPyodide: any = (globalThis as any).loadPyodide;
    if (typeof loadPyodide !== 'function') {
      throw new Error('Pyodide glue loaded but global loadPyodide is missing');
    }
    return loadPyodide;
  })();

  _factoryCache.set(key, promise);
  return promise;
}
