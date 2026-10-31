/**
 * aw_core · loader.ts — one loader for every flavour of WASM.
 *
 *   · `load()`           — raw .wasm bytes; mode auto-detected from imports.
 *   · `runEmscripten()`  — Emscripten JS glue factory (the ffmpeg.wasm style).
 *   · `runWasi()`        — a WASI preview1 binary with argv/env, on node:wasi
 *                          when available and our pure-JS shim otherwise.
 *
 * Zero native compilation. Works in Node 12+ and in the browser.
 */

import { isNode, loadBytes, nodeRequire } from './env';
import { createMinimalWasiImports, tryNodeWasi, WasiExit } from './wasi-min';

export type WasmMode = 'auto' | 'emscripten' | 'wasi' | 'plain';

export type WasmSource = string | URL | Uint8Array | ArrayBuffer;

export interface LoadOptions {
  /** URL / file path / in-memory bytes of the `.wasm` module; optional when the
   *  caller supplies bytes some other way (e.g. Emscripten glue loading). */
  source?: WasmSource;
  /** Force a mode; default `auto` sniffs the import table. */
  mode?: WasmMode;
  /** Extra imports merged in last (winner over defaults), namespaced. */
  imports?: Record<string, Record<string, any>>;
  /** argv passed to a WASI guest (or Emscripten main, when supported). */
  args?: string[];
  /** environ entries (`KEY=VALUE`) passed to a WASI guest. */
  env?: string[];
  /** Emscripten print / stderr sinks. */
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /** Binary name as the guest's argv[0]. */
  name?: string;
}

export interface LoadedModule {
  readonly module: WebAssembly.Module;
  readonly instance: WebAssembly.Instance;
  readonly exports: Record<string, any>;
  readonly kind: 'emscripten' | 'wasi' | 'plain';
  readonly bytes: Uint8Array;
  /** Emscripten-style entry, present when the glue exposes one. */
  callMain?: (args: string[]) => number;
  /** WASI exit code carrier, if the module exited via proc_exit. */
  wasiExitCode?: number;
  /** Diagnostics about how imports were satisfied. */
  readonly notes: string[];
}

interface ImportShape {
  module: string;
  name: string;
  kind: string;
}

/**
 * Import object that never fails `WebAssembly.instantiate` on a missing
 * namespace: unknown functions resolve to a tracer that throws on *call*
 * instead of crashing the link step. This is what makes the loader "fast and
 * forgiving" — modules with rich glue still link; they only break if they
 * actually use a syscall we never provided.
 */
export function createLenientImports(base: Record<string, Record<string, any>>): any {
  const namespaces: Record<string, any> = {};
  const usedNote: string[] = [];

  const stub = (module: string, name: string): any => {
    const fn = function (..._args: any[]): any {
      usedNote.push('called unlinked import: ' + module + '.' + name);
      throw new Error('Anywhere: unlinked import ' + module + '.' + name);
    };
    return fn;
  };

  const nsProxy = (moduleName: string) =>
    new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (base[moduleName] && prop in base[moduleName]) {
            return base[moduleName][prop];
          }
          if (prop === '__esModule') return false;
          return stub(moduleName, prop);
        },
        has() {
          return true;
        },
      }
    );

  const root: Record<string, any> = {};
  for (const ns of Object.keys(base)) root[ns] = base[ns];

  const proxy = new Proxy(root, {
    get(_t, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop === 'then') return undefined;
      if (root[prop] !== undefined) return root[prop];
      const ns = nsProxy(prop);
      root[prop] = ns;
      return ns;
    },
    has() {
      return true;
    },
  });
  Object.defineProperty(proxy, '__notes', { value: usedNote, enumerable: false });
  return proxy;
}

function detectMode(module: WebAssembly.Module, forced: WasmMode): 'emscripten' | 'wasi' | 'plain' {
  if (forced === 'emscripten') return 'emscripten';
  if (forced === 'wasi') return 'wasi';
  if (forced === 'plain') return 'plain';
  const imports = WebAssembly.Module.imports(module) as ImportShape[];
  const modules = new Set(imports.map((i) => i.module));
  if (modules.has('wasi_snapshot_preview1') || modules.has('wasi_unstable')) return 'wasi';
  if (modules.has('env')) return 'emscripten';
  return 'plain';
}

export class WasmLoader {
  /**
   * Load raw WASM bytes and link them with the best-matching import object.
   */
  public async load(options: LoadOptions): Promise<LoadedModule> {
    const bytes = await loadBytes(options.source as WasmSource);
    const module = new WebAssembly.Module(bytes as unknown as BufferSource);
    const kind = detectMode(module, options.mode || 'auto');
    const notes: string[] = [];

    const memoryHolder: { memory: WebAssembly.Memory | null } = { memory: null };

    const base: Record<string, Record<string, any>> = { env: {} };
    if (options.imports) {
      for (const ns of Object.keys(options.imports)) {
        base[ns] = Object.assign({}, base[ns] || {}, options.imports[ns]);
      }
    }

    if (kind === 'wasi') {
      const argv = [options.name || 'aw_module'].concat(options.args || []);
      const envEntries = options.env || [];
      const nodeWasi = tryNodeWasi();
      if (nodeWasi) {
        try {
          const wasi = new nodeWasi.WASI({
            version: 'preview1',
            args: argv,
            env: envEntries,
            preopens: {},
          });
          base['wasi_snapshot_preview1'] = wasi.getImportObject
            ? wasi.getImportObject()
            : (wasi.wasiImport as any);
          notes.push('wasi: node:wasi');
        } catch (err) {
          notes.push('wasi: node:wasi failed, shim (' + String(err) + ')');
          base['wasi_snapshot_preview1'] = createMinimalWasiImports({
            args: argv,
            env: envEntries,
            memoryHolder,
          })['wasi_snapshot_preview1'];
        }
      } else {
        notes.push('wasi: pure-js shim');
        base['wasi_snapshot_preview1'] = createMinimalWasiImports({
          args: argv,
          env: envEntries,
          stdout: options.stdout,
          stderr: options.stderr,
          memoryHolder,
        })['wasi_snapshot_preview1'];
      }
    }

    const imports = createLenientImports(base);
    const instance = new WebAssembly.Instance(module, imports as any);
    const exports = instance.exports as any;
    memoryHolder.memory = exports.memory || null;

    if ((imports as any).__notes && (imports as any).__notes.length) {
      notes.push.apply(notes, (imports as any).__notes);
    }

    let callMain: ((args: string[]) => number) | undefined;
    if (typeof exports.main === 'function') {
      callMain = (args: string[]) => {
        try {
          return (exports.main as (argc: number, argv: number) => number)(
            (args || []).length,
            0
          );
        } catch (err) {
          if (err instanceof WasiExit) return err.exitCode || 0;
          throw err;
        }
      };
    } else if (typeof exports._main === 'function') {
      callMain = (args: string[]) => {
        try {
          return (exports._main as (argc: number, argv: number) => number)(
            (args || []).length,
            0
          );
        } catch (err) {
          if (err instanceof WasiExit) return err.exitCode || 0;
          throw err;
        }
      };
    }

    return {
      module,
      instance,
      exports,
      kind,
      bytes,
      callMain,
      notes,
    } as LoadedModule & { wasiExitCode?: number };
  }

  /**
   * Drive an Emscripten glue *factory* (`createFFmpegCore()` style) with the
   * host callbacks Anywhere standardises. Returns the glue's module object,
   * ready for `callMain()` / ccall / FS access.
   */
  public async runEmscripten<T = any>(factory: EmscriptenFactory, options: LoadOptions = {}): Promise<T> {
    const locateFile = (name: string): string => {
      if (typeof options.source === 'string' && !/^https?:\/\//i.test(options.source)) {
        const path = nodeRequire('path');
        if (path && isNode()) return path.join(path.dirname(options.source as string), name);
      }
      const base = typeof options.source === 'string' ? options.source : '.';
      const slash = base.lastIndexOf('/');
      return slash >= 0 ? base.slice(0, slash + 1) + name : name;
    };
    const glue = await factory({
      print: options.stdout || ((s: string) => console.log(s)),
      printErr: options.stderr || ((s: string) => console.error(s)),
      locateFile,
      arguments: options.args,
      noFSInit: false,
      preRun: [],
      postRun: [],
    });
    return glue as T;
  }
}

export type EmscriptenFactory = (overrides: Record<string, any>) => Promise<any> | any;

/**
 * Fetch a module's byte size without instantiating it — used by the CLI for
 * `anywhere info` style quick introspection.
 */
export async function probeWasm(source: WasmSource): Promise<{
  byteLength: number;
  imports: ImportShape[];
  exports: { name: string; kind: string }[];
}> {
  const bytes = await loadBytes(source);
  const module = new WebAssembly.Module(bytes as unknown as BufferSource);
  return {
    byteLength: bytes.byteLength,
    imports: WebAssembly.Module.imports(module) as ImportShape[],
    exports: WebAssembly.Module.exports(module) as any,
  };
}

/** Singleton loader for convenience (`aw` packages share it). */
export const loader = new WasmLoader();
