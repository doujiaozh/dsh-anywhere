/**
 * aw_core · worker.ts — transports over worker_threads (Node) & Web Workers.
 *
 * Running a WASM engine on a worker thread keeps the host event loop free and
 * gives us a real isolation boundary for untrusted payloads. The wire format
 * is plain JSON-RPC 2.0, exactly the same as on the main thread: a worker
 * entry built with `serveWorker()` is callable with `bus.call()` from host.
 *
 * Handshake protocol:
 *   host  → worker : rpc call  `aw:handshake` { init }   (per-workspace payload)
 *   worker → host  : rpc result { ok: true, ... }        (worker is ready)
 */

import { isNode, nodeRequire } from './env';
import { JsonRpcBus, RpcHandler, Transport } from './bus';

/** Transport over an already-created Node worker_threads Worker. */
export class NodeWorkerTransport implements Transport {
  public readonly worker: any;
  private closed = false;
  private subscriber: ((m: any) => void) | null = null;

  constructor(worker: any) {
    this.worker = worker;
    worker.on('message', (m: any) => {
      if (this.subscriber) this.subscriber(m);
    });
    worker.on('error', (err: Error) => {
      if (this.subscriber) this.subscriber({ __workerError: String(err && err.message || err) });
    });
    worker.on('exit', () => {
      this.closed = true;
      if (this.subscriber) this.subscriber({ __workerClosed: true });
    });
  }

  /** Spawn `workerFile` (JS) inside a worker thread and wrap it. */
  public static spawn(workerFile: string, workerData?: any): NodeWorkerTransport {
    if (!isNode()) throw new Error('NodeWorkerTransport requires Node.js');
    const wt: any = nodeRequire('worker_threads');
    if (!wt || !wt.Worker) throw new Error('worker_threads unavailable on this host');
    const worker = new wt.Worker(workerFile, { workerData } as any);
    return new NodeWorkerTransport(worker);
  }

  public post(message: any): void {
    if (this.closed) throw new Error('worker exited');
    this.worker.postMessage(message);
  }

  public subscribe(handler: (m: any) => void): () => void {
    this.subscriber = handler;
    return () => {
      if (this.subscriber === handler) this.subscriber = null;
    };
  }

  public close(): void {
    this.closed = true;
    try {
      this.worker.terminate();
    } catch (_e) {
      /* already gone */
    }
  }
}

/** Transport over a browser Web Worker. */
export class BrowserWorkerTransport implements Transport {
  public readonly worker: any;
  private subscriber: ((m: any) => void) | null = null;

  constructor(worker: any) {
    this.worker = worker;
    worker.addEventListener('message', (ev: any) => {
      if (this.subscriber) this.subscriber(ev.data);
    });
  }

  public static spawn(url: string | URL): BrowserWorkerTransport {
    const g = globalThis as any;
    if (typeof g.Worker !== 'function') throw new Error('Web Workers unavailable here');
    return new BrowserWorkerTransport(new g.Worker(url));
  }

  public post(message: any): void {
    this.worker.postMessage(message);
  }

  public subscribe(handler: (m: any) => void): () => void {
    this.subscriber = handler;
    return () => {
      if (this.subscriber === handler) this.subscriber = null;
    };
  }

  public close(): void {
    this.worker.terminate();
  }
}

export interface ServeWorkerOptions {
  /** Methods the worker exposes to the host. */
  methods: Record<string, RpcHandler>;
  /** Hook run during `aw:handshake` before the worker declares readiness. */
  init?: (payload: any) => Promise<any> | any;
  /** Bus diagnostics label. */
  name?: string;
  /** Called when the worker is asked to shut down (`aw:dispose`). */
  dispose?: () => Promise<void> | void;
}

/** Worker-side helper: expose JSON-RPC methods over `parentPort`. */
export function serveWorker(options: ServeWorkerOptions): JsonRpcBus {
  if (!isNode()) throw new Error('serveWorker() is for Node worker_threads entries');
  const wt: any = nodeRequire('worker_threads');
  if (!wt || !wt.parentPort) throw new Error('serveWorker() must run inside a worker thread');

  const port = wt.parentPort;
  const transport: Transport = {
    post: (m: any) => port.postMessage(m),
    subscribe: (handler: (m: any) => void) => {
      port.on('message', handler);
      return () => port.off('message', handler);
    },
    close: () => port.close(),
  };
  const bus = new JsonRpcBus(transport, { name: options.name || 'aw-worker' });

  bus.handle('aw:handshake', async (payload: any) => {
    if (options.init) {
      const extra = await options.init(payload);
      return Object.assign({ ok: true }, extra || {});
    }
    return { ok: true };
  });

  if (options.dispose) {
    const dispose = options.dispose;
    bus.handle('aw:dispose', async () => {
      await dispose();
      bus.close();
      return { ok: true };
    });
  }

  for (const name of Object.keys(options.methods)) {
    bus.handle(name, options.methods[name]);
  }

  port.postMessage({ jsonrpc: '2.0', method: 'aw:ready', params: { name: options.name || 'aw-worker' } });
  return bus;
}

/**
 * Host-side helper: spawn a worker file, handshake it, hand back a ready bus.
 * This is the one-call path used by the capability packages.
 */
export async function spawnWorkerRpc(workerFile: string, initPayload?: any, name?: string): Promise<JsonRpcBus> {
  const transport = NodeWorkerTransport.spawn(workerFile, initPayload);
  return handshake(transport, initPayload, name);
}

/** Common handshake sequence over any worker transport. */
export async function handshake(
  transport: Transport,
  initPayload?: any,
  name?: string
): Promise<JsonRpcBus> {
  const bus = new JsonRpcBus(transport, { name: name || 'aw-host' });
  const ready = (bus as any); // bus not closed; call directly
  const res = await ready.call('aw:handshake', initPayload || {}, 60000);
  if (!res || res.ok !== true) {
    bus.close();
    throw new Error('Worker handshake failed: ' + JSON.stringify(res));
  }
  return bus;
}
