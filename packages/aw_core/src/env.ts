/**
 * aw_core · env.ts — runtime detection & portable resource loading.
 *
 * The single place that knows the difference between Node.js and the browser.
 * Everything else in Anywhere talks to this surface, so capability packages
 * stay 100% host-agnostic.
 */

export type RuntimeKind = 'node' | 'browser' | 'unknown';

/** Detect the host runtime once; cached for the process lifetime. */
let _runtime: RuntimeKind | null = null;

export function detectRuntime(): RuntimeKind {
  if (_runtime !== null) return _runtime;
  if (typeof (globalThis as any) !== 'undefined') {
    const g = globalThis as any;
    if (g.process && g.process.versions && typeof g.process.versions.node === 'string') {
      _runtime = 'node';
      return _runtime;
    }
    if (typeof g.window === 'object' && typeof g.document === 'object') {
      _runtime = 'browser';
      return _runtime;
    }
  }
  _runtime = 'unknown';
  return _runtime;
}

export function isNode(): boolean {
  return detectRuntime() === 'node';
}

export function isBrowser(): boolean {
  return detectRuntime() === 'browser';
}

/**
 * Safe `require` from CommonJS code without declaring a static dependency on
 * a Node type surface. Returns null when the module is unavailable.
 */
export function nodeRequire(name: string): any | null {
  if (!isNode()) return null;
  try {
    // tslint:disable-next-line no-eval
    const fn = new Function('name', 'return eval("require")(name)') as (n: string) => any;
    return fn(name);
  } catch (_err) {
    return null;
  }
}

let _fs: any | null = null;
function fs(): any | null {
  if (_fs === null) _fs = nodeRequire('fs');
  return _fs === null ? null : _fs;
}

let _path: any | null = null;
function pathModule(): any | null {
  if (_path === null) _path = nodeRequire('path');
  return _path === null ? null : _path;
}

let _http: any | null = null;
function httpModule(): any | null {
  if (_http === null) {
    const mod = nodeRequire('http');
    const https = nodeRequire('https');
    _http = { http: mod, https };
  }
  return _http === null || _http === undefined ? null : _http;
}

/** True when the source string looks like an http/https URL. */
export function isHttpUrl(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

/** True when the source looks like an absolute or relative filesystem path. */
export function isFileSystemPath(source: string): boolean {
  if (isHttpUrl(source)) return false;
  if (isNode()) return true;
  // In a browser, a bare path with no protocol is resolved against document base.
  return false;
}

/** Resolve a possibly-relative path against the process cwd (Node only). */
export function resolveFilePath(source: string): string {
  const path = pathModule();
  if (path === null) return source;
  return path.isAbsolute(source) ? source : path.resolve(process.cwd(), source);
}

/**
 * Load a byte payload from anywhere: http(s) URL, local file, an in-memory
 * buffer, or a data: URL. Works identically in Node and the browser.
 */
export async function loadBytes(source: string | URL | Uint8Array | ArrayBuffer): Promise<Uint8Array> {
  if (source instanceof Uint8Array) return source;
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  if (typeof source !== 'string' && (source as any) instanceof URL) {
    return loadBytes(String(source));
  }
  if (typeof source === 'string') {
    if (/^data:.*?base64,/i.test(source)) {
      const comma = source.indexOf(',');
      const payload = source.slice(comma + 1);
      return base64ToBytes(payload);
    }
    if (isHttpUrl(source)) return fetchUrlBytes(source);
    if (isNode()) {
      const f = fs();
      if (f !== null) {
        const resolved = resolveFilePath(source);
        return await f.promises.readFile(resolved);
      }
    }
    return fetchUrlBytes(source);
  }
  throw new TypeError('Unsupported byte source: ' + String(source));
}

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/=]/g, '');
  const binary = atobPolyfill(clean);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function atobPolyfill(input: string): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const str = input.replace(/=+$/, '');
  let output = '';
  let bc = 0;
  let bs = 0;
  for (let idx = 0; idx < str.length; idx++) {
    const ch = chars.indexOf(str.charAt(idx));
    if (ch === -1) continue;
    bs = (bs << 6) | ch;
    bc += 6;
    if (bc >= 8) {
      output += String.fromCharCode((bs >>> (bc - 8)) & 0xff);
      bc -= 8;
    }
  }
  return output;
}

async function fetchUrlBytes(url: string): Promise<Uint8Array> {
  const g = globalThis as any;
  if (typeof g.fetch === 'function') {
    const res = await g.fetch(url);
    if (!res.ok) throw new Error('Fetch failed for ' + url + ': HTTP ' + res.status);
    const ab = await res.arrayBuffer();
    return new Uint8Array(ab);
  }
  const mods = httpModule();
  if (mods === null || mods.https === null) {
    throw new Error('No fetch() and no http module available to load ' + url);
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    const lib = url.toLowerCase().startsWith('https://') ? mods.https : mods.http;
    lib
      .get(url, (res: any) => {
        if (res.statusCode !== undefined && (res.statusCode < 200 || res.statusCode >= 300)) {
          reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
      })
      .on('error', (err: Error) => reject(err));
  });
}

export { fs as nodeFs, pathModule as nodePath };
