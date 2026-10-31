/**
 * aw_edge_llm · ort.ts — locate & load ONNX Runtime Web, zero native deps.
 *
 * `onnxruntime-web` ships pure-WASM backends (wasm by default; webgl in a
 * browser). Loading it anywhere means: prefer the npm copy when installed,
 * otherwise fetch the pinned CDN bundle. On a Win7 box with no compilers,
 * this is the whole difference between "AI works" and "AI doesn't".
 */

import { isNode, loadBytes, nodeFs, nodePath, nodeRequire } from '@anywhere/core';

/** Pinned ort-web release. npm dist-tag parity keeps glue & wasm assets aligned. */
export const ORT_VERSION = '1.19.2';

export const ORT_CDN_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;

export type OrtBackend = 'wasm' | 'webgl' | 'webgpu';

export interface OrtLoadOptions {
  /**
   * Where to resolve the library:
   *   - `'npm'`          → installed `onnxruntime-web` package (Node default)
   *   - `'cdn'`          → pinned jsDelivr bundle (browser default)
   *   - url/path string  → an exact path to ort.<suffix>.js
   */
  source?: 'npm' | 'cdn' | string;
  /** Preferred execution backend. wasm works everywhere; webgl needs a GPU. */
  backend?: OrtBackend;
  /** Number of wasm threads (keep 1 on low-spec hosts). */
  numThreads?: number;
  /** Where wasm binaries live when not bundled with the glue (CDN mode). */
  wasmPath?: string;
}

export interface OrtModule {
  InferenceSession: any;
  Tensor: any;
  env: any;
  createSession?: any;
}

export interface OrtHandle {
  ort: OrtModule;
  version: string;
  backend: OrtBackend;
}

const _cache: { handle: Promise<OrtHandle> | null; key: string | null } = { handle: null, key: null };

/**
 * Load ONNX Runtime Web exactly once per process. The returned handle is the
 * module (`InferenceSession.create(...)` etc.) plus what we configured.
 */
export function loadOrt(options: OrtLoadOptions = {}): Promise<OrtHandle> {
  const key = JSON.stringify([options.source || 'auto', options.backend || 'wasm', options.numThreads || 1, options.wasmPath || '']);
  if (_cache.handle && _cache.key === key) return _cache.handle;
  _cache.key = key;
  _cache.handle = (async (): Promise<OrtHandle> => {
    const ort = await obtainOrtModule(options.source);
    const backend: OrtBackend = options.backend || 'wasm';

    // ort-web ≥1.18 auto-configures; explicit hints still help low-spec boxes.
    const env = ort.env;
    if (env) {
      if (backend === 'wasm') {
        if (options.numThreads) env.wasm = Object.assign({}, env.wasm, { numThreads: options.numThreads });
        if (options.wasmPath && env.wasm) env.wasm.wasmPaths = options.wasmPath;
      }
      if (env.backend) {
        try {
          await env.backend.setEager(backend, { preferCPU: backend === 'wasm' });
        } catch (_e) {
          /* older ort versions: selection happens at session creation */
        }
      }
      if (typeof env.setBackend === 'function') {
        try {
          await env.setBackend(backend);
        } catch (_e) {
          /* fall through to default */
        }
      }
    }

    return { ort, version: ORT_VERSION, backend };
  })();
  return _cache.handle;
}

async function obtainOrtModule(source?: OrtLoadOptions['source']): Promise<OrtModule> {
  const auto = !source || source === 'auto';
  if (source === 'npm' || (auto && isNode())) {
    try {
      const mod: any = nodeRequire('onnxruntime-web');
      const ort: any = mod && (mod.default || mod);
      if (ort && ort.InferenceSession) return ort;
    } catch (_e) {
      if (source === 'npm') {
        throw new Error(
          'Anywhere: `onnxruntime-web` not installed. Run `npm i onnxruntime-web` or use source:"cdn".'
        );
      }
    }
  }

  const url = resolveOrtUrl(source);
  if (isNode()) {
    return loadOrtFromUrlNode(url);
  }
  return loadOrtFromUrlBrowser(url);
}

export function resolveOrtUrl(source?: OrtLoadOptions['source']): string {
  if (!source || source === 'auto' || source === 'cdn') {
    // Node gets the UMD build made for it; browsers get the web bundle.
    return isNode() ? ORT_CDN_BASE + 'ort.node.min.js' : ORT_CDN_BASE + 'ort.min.js';
  }
  if (source === 'npm') return ORT_CDN_BASE + 'ort.node.min.js';
  if (typeof source === 'string') return source;
  return ORT_CDN_BASE + 'ort.min.js';
}

async function loadOrtFromUrlNode(url: string): Promise<OrtModule> {
  const fs = nodeFs();
  const path = nodePath();
  if (fs === null || path === null) throw new Error('Node fs/path unavailable for ort load');
  const bytes = await loadBytes(url);
  const os = nodeRequire('os');
  const tmp = path.join(os.tmpdir(), 'anywhere-ort-' + ORT_VERSION + '-cjs.js');
  fs.writeFileSync(tmp, bytes);
  // UMD bundle: evaluates into module.exports when required.
  const req = new Function('f', 'return eval("require")(f)') as (f: string) => any;
  const mod = req(tmp);
  return normalizeOrt(mod);
}

async function loadOrtFromUrlBrowser(url: string): Promise<OrtModule> {
  // Same origin-independent UMD bundle; defines globalThis.ort.
  return loadOrtScriptTag(url);
}

function loadOrtScriptTag(url: string): Promise<OrtModule> {
  return new Promise<OrtModule>((resolve, reject) => {
    const doc = (globalThis as any).document;
    if (!doc) return reject(new Error('No document for ' + url));
    const el = doc.createElement('script');
    el.src = url;
    el.onload = () => {
      const ort = normalizeOrt((globalThis as any).ort);
      if (!ort.InferenceSession) return reject(new Error('ort loaded without InferenceSession'));
      resolve(ort);
    };
    el.onerror = () => reject(new Error('Failed to load ' + url));
    doc.head.appendChild(el);
  });
}

function normalizeOrt(mod: any): OrtModule {
  const ort = mod && (mod.default || mod);
  if (!ort || !ort.InferenceSession) throw new Error('onnxruntime-web module missing InferenceSession');
  return ort;
}

function pathToFileURL(p: string): string {
  return 'file://' + p.replace(/\\/g, '/');
}
