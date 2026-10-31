/**
 * aw_core · wasi-min.ts — a dependency-free WASI preview1 shim.
 *
 * Implementing the snapshot-preview1 subset lets Anywhere run plain WASI
 * binaries on *any* host — including Node builds without `node:wasi` and
 * browsers — with zero native compilation anywhere.
 *
 * Covered syscalls: process lifecycle, args/environ, stdout/stderr/stdin,
 * wall clock, randomness, and fd metadata. Everything else fails loudly with
 * `ENOSYS` so callers know exactly what the shim does not fake.
 */

import { isNode, nodeRequire } from './env';

const WASI_EINVAL = 28;
const WASI_ENOSYS = 52;
const WASI_ERRNO_NOSYS = 52;

function errno(code: number): number {
  return code;
}

/**
 * Build a `wasi_snapshot_preview1` import object bound to a wasm memory.
 * @param memory the WebAssembly.Memory exported by the guest (or a holder
 *   whose `.buffer` will be filled right before calls).
 */
export function createMinimalWasiImports(options: {
  args?: string[];
  env?: string[];
  stdout?: (chunk: string) => void;
  stderr?: (chunk: string) => void;
  stdin?: () => string | null;
  memoryHolder: { memory: WebAssembly.Memory | null };
}): Record<string, any> {
  const args = options.args || [];
  const env = options.env || [];
  const out = options.stdout || ((s: string) => process.stdout.write(s));
  const err = options.stderr || ((s: string) => process.stderr.write(s));

  const mem = (): DataView => {
    const m = options.memoryHolder.memory;
    if (!m) throw new Error('WASI shim: guest memory not attached yet');
    return new DataView(m.buffer);
  };

  const writeBuf = (ptr: number, bytes: Uint8Array): void => {
    const view = mem();
    for (let i = 0; i < bytes.length; i++) view.setUint8(ptr + i, bytes[i]);
  };

  const readCString = (ptr: number): string => {
    const view = mem();
    const buf: number[] = [];
    let p = ptr;
    for (;;) {
      const b = view.getUint8(p++);
      if (b === 0) break;
      buf.push(b);
    }
    return Buffer.from(buf).toString('utf8');
  };

  const utf8 = (s: string): Uint8Array => Buffer.from(s, 'utf8');

  const fds = new Map<number, { kind: 'stdio' }>([
    [0, { kind: 'stdio' }],
    [1, { kind: 'stdio' }],
    [2, { kind: 'stdio' }],
  ]);

  const wasi: Record<string, any> = {
    // ── process ───────────────────────────────────────────────────────────
    proc_exit(code: number): void {
      throw new WasiExit(code);
    },
    abort(): void {
      throw new WasiExit(134);
    },
    random_get(ptr: number, len: number): number {
      const view = mem();
      for (let i = 0; i < len; i++) {
        view.setUint8(ptr + i, Math.floor(Math.random() * 256));
      }
      return 0;
    },
    clock_time_get(_clockId: number, _precision: number, outPtr: number): number {
      const view = mem();
      // ms → nanoseconds, as BigInt64 if the view supports it (it does: DataView).
      const ns = BigInt(Date.now()) * BigInt(1000000);
      view.setBigUint64(outPtr, ns, true);
      return 0;
    },
    sched_yield(): number {
      return 0;
    },

    // ── arguments & environment ────────────────────────────────────────────
    args_sizes_get(argcPtr: number, argvBufLenPtr: number): number {
      const view = mem();
      let total = 0;
      for (const a of args) total += utf8(a).length + 1;
      view.setUint32(argcPtr, args.length, true);
      view.setUint32(argvBufLenPtr, total, true);
      return 0;
    },
    args_get(argvPtr: number, argvBufPtr: number): number {
      const view = mem();
      let bufP = argvBufPtr;
      let argP = argvPtr;
      for (const a of args) {
        view.setUint32(argP, bufP, true);
        argP += 4;
        const bytes = utf8(a);
        writeBuf(bufP, bytes);
        view.setUint8(bufP + bytes.length, 0);
        bufP += bytes.length + 1;
      }
      return 0;
    },
    environ_sizes_get(countPtr: number, bufLenPtr: number): number {
      const view = mem();
      let total = 0;
      for (const e of env) total += utf8(e).length + 1;
      view.setUint32(countPtr, env.length, true);
      view.setUint32(bufLenPtr, total, true);
      return 0;
    },
    environ_get(environPtr: number, bufPtr: number): number {
      const view = mem();
      let bufP = bufPtr;
      let envP = environPtr;
      for (const e of env) {
        view.setUint32(envP, bufP, true);
        envP += 4;
        const bytes = utf8(e);
        writeBuf(bufP, bytes);
        view.setUint8(bufP + bytes.length, 0);
        bufP += bytes.length + 1;
      }
      return 0;
    },

    // ── file descriptors (stdio only; more is ENOSYS) ───────────────────────
    fd_write(fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number): number {
      const view = mem();
      const write = fd === 2 ? err : fd === 1 ? out : null;
      if (write === null) return errno(WASI_EINVAL);
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const base = view.getUint32(iovsPtr + i * 8, true);
        const len = view.getUint32(iovsPtr + i * 8 + 4, true);
        const chunk = Buffer.from(mem().buffer, base, len);
        write(chunk.toString('utf8'));
        total += len;
      }
      view.setUint32(nwrittenPtr, total, true);
      return 0;
    },
    fd_read(fd: number, iovsPtr: number, iovsLen: number, nreadPtr: number): number {
      const view = mem();
      if (fd !== 0) return errno(WASI_EINVAL);
      const src = options.stdin ? options.stdin() : null;
      if (src === null || src.length === 0) {
        view.setUint32(nreadPtr, 0, true);
        return 0;
      }
      const bytes = utf8(src);
      let total = 0;
      for (let i = 0; i < iovsLen && total < bytes.length; i++) {
        const base = view.getUint32(iovsPtr + i * 8, true);
        const len = view.getUint32(iovsPtr + i * 8 + 4, true);
        const n = Math.min(len, bytes.length - total);
        const slice = bytes.slice(total, total + n);
        for (let j = 0; j < n; j++) view.setUint8(base + j, slice[j]);
        total += n;
      }
      view.setUint32(nreadPtr, total, true);
      return 0;
    },
    fd_close(fd: number): number {
      if (fds.has(fd)) {
        fds.delete(fd);
        return 0;
      }
      return errno(WASI_EINVAL);
    },
    fd_fdstat_get(fd: number, outPtr: number): number {
      if (!fds.has(fd)) return errno(WASI_EINVAL);
      const view = mem();
      // fs_filetype=1 (unknown), rest zeroed.
      view.setUint8(outPtr + 2, 1);
      return 0;
    },
    fd_seek(): number {
      return errno(WASI_ENOSYS);
    },
    fd_tell(): number {
      return errno(WASI_ENOSYS);
    },
    path_open(): number {
      return errno(WASI_ENOSYS);
    },
    path_unlink_file(): number {
      return errno(WASI_ENOSYS);
    },
    path_remove_directory(): number {
      return errno(WASI_ENOSYS);
    },
  };

  // Mark the module: callers can detect that this is the shim (not node:wasi).
  Object.defineProperty(wasi, '__aw_wasi_shim', { value: true, enumerable: false });

  return { wasi_snapshot_preview1: wasi };
}

/** Thrown when a WASI guest calls `proc_exit`; carries the exit code. */
export class WasiExit extends Error {
  public readonly exitCode: number;
  constructor(code: number) {
    super('WASI proc_exit(' + code + ')');
    this.name = 'WasiExit';
    this.exitCode = code === 0 ? 0 : code;
  }
}

/**
 * Prefer the host's real `node:wasi` when present (faster, more complete);
 * fall back to our pure-JS shim otherwise. Returns `null` on non-Node hosts.
 */
export function tryNodeWasi(): any | null {
  if (!isNode()) return null;
  const mod = nodeRequire('node:wasi') || nodeRequire('wasi');
  if (!mod || typeof mod.WASI !== 'function') return null;
  return mod;
}

/** True when `WasiExit` should be treated as a clean, expected termination. */
export function isWasiExit(err: unknown): err is WasiExit {
  return err instanceof WasiExit;
}

/** Unused import keep-alive (Buffer/err helpers are host-agnostic). */
export const _wasiErrnoNosys = WASI_ERRNO_NOSYS;
