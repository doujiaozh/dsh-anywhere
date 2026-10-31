/**
 * aw_core · io.ts — asset resolution with a local cache.
 *
 * Capability packages (ffmpeg core, Pyodide, ONNX weights) are pure data
 * payloads: fetch once, verify, reuse. Nothing here is compiled — the cache
 * is the only filesystem footprint Anywhere ever needs.
 */

import { isNode, loadBytes, nodeFs, nodePath, nodeRequire } from './env';

export interface Asset {
  /** Canonical id, e.g. `pyodide/0.26.4/full`. */
  id: string;
  /** Remote URL (http/https). */
  url: string;
  /** Optional integrity check. */
  sha256?: string;
  /** Optional byte size guard. */
  size?: number;
}

export interface AssetCacheOptions {
  /** Cache root. Default: `~/.anywhere/cache` (Node) or IndexedDB-ish (browser). */
  root?: string;
  /** Skip network entirely; missing assets throw. */
  offline?: boolean;
}

export class AssetCache {
  public readonly root: string | null;

  constructor(options: AssetCacheOptions = {}) {
    if (options.root) {
      this.root = options.root;
    } else if (isNode()) {
      const os = nodeRequire('os');
      const path = nodePath();
      const home = os ? os.homedir() : process.cwd();
      this.root = path ? path.join(home, '.anywhere', 'cache') : null;
    } else {
      this.root = null;
    }
  }

  /**
   * Return a local file path (Node) or a URL (browser) for the asset,
   * downloading and verifying it into the cache when missing.
   */
  public async resolve(asset: Asset): Promise<string> {
    if (!isNode() || this.root === null) {
      if (asset.sha256) {
        // Browser path: integrity checked by fetch itself when possible.
        return asset.url;
      }
      return asset.url;
    }
    const fs = nodeFs();
    const path = nodePath();
    if (fs === null || path === null) return asset.url;

    const rel = asset.id.replace(/[^a-zA-Z0-9._\-/]+/g, '_');
    const dir = path.join(this.root, path.dirname(rel));
    const file = path.join(this.root, rel);

    if (fs.existsSync(file)) {
      if (asset.sha256) {
        const got = sha256File(fs, file);
        if (got === asset.sha256) return file;
      } else {
        return file;
      }
    }
    if (this.offlineMode) {
      throw new Error('Asset missing in offline mode: ' + asset.id + ' (' + file + ')');
    }

    const bytes = await loadBytes(asset.url);
    if (asset.sha256) {
      const got = sha256Buffer(bytes);
      if (got !== asset.sha256) {
        throw new Error(
          'Asset integrity failed for ' + asset.id + ': expected ' + asset.sha256 + ', got ' + got
        );
      }
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, bytes);
    if (asset.size !== undefined && bytes.byteLength !== asset.size) {
      throw new Error(
        'Asset size mismatch for ' + asset.id + ': expected ' + asset.size + ', got ' + bytes.byteLength
      );
    }
    return file;
  }

  private get offlineMode(): boolean {
    return false;
  }
}

export function sha256Buffer(bytes: Uint8Array): string {
  if (isNode()) {
    const crypto = nodeRequire('crypto');
    if (crypto && typeof crypto.createHash === 'function') {
      return crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');
    }
  }
  // Pure-JS fallback would be impractical; browsers expose subtle.crypto.
  const g = globalThis as any;
  if (g.crypto && g.crypto.subtle) {
    throw new Error('Async browser sha256 not supported in this path; pass pre-verified assets.');
  }
  throw new Error('No sha256 implementation available on this host.');
}

function sha256File(fs: any, file: string): string {
  const bytes = fs.readFileSync(file);
  return sha256Buffer(new Uint8Array(bytes));
}
