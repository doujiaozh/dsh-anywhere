/**
 * aw_core · bus.ts — bidirectional JSON-RPC 2.0 bus.
 *
 * One bus sits on each end of a transport. From the host side you `call()`
 * into the wasm world; from the wasm side you `handle()` methods the sandbox
 * may invoke (the bus is fully symmetric, so the same class powers both).
 */

import {
  AwErrorCode,
  isRpcRequest,
  isRpcResponse,
  makeError,
  makeNotification,
  makeRequest,
  makeResult,
  nextRpcId,
  RpcError,
  rpcErrorFrom,
  RpcErrorCode,
  RpcId,
  RpcRequest,
  RpcResponse,
} from './rpc';

export type RpcHandler = (params: any) => Promise<any> | any;

/** The minimal contract a bus runs on: push messages across the wire. */
export interface Transport {
  post(message: any): void;
  subscribe(handler: (message: any) => void): () => void;
  close?(): void;
}

export interface BusOptions {
  /** Name used for diagnostics / logging. */
  name?: string;
  /** Default timeout for `call()` in ms. Default: 30s. */
  defaultTimeoutMs?: number;
  /** Sink for protocol-level diagnostics. */
  log?: (line: string) => void;
}

interface Pending {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer: any;
  method: string;
}

export class JsonRpcBus {
  public readonly name: string;
  private readonly transport: Transport;
  private readonly defaultTimeoutMs: number;
  private readonly log: (line: string) => void;
  private readonly handlers = new Map<string, RpcHandler>();
  private readonly pending = new Map<number, Pending>();
  private closed = false;
  private unsubscribe: (() => void) | null = null;

  constructor(transport: Transport, options: BusOptions = {}) {
    this.transport = transport;
    this.name = options.name || 'aw-bus';
    this.defaultTimeoutMs =
      options.defaultTimeoutMs === undefined ? 30000 : options.defaultTimeoutMs;
    this.log = options.log || (() => undefined);
    this.unsubscribe = transport.subscribe((msg) => this.onMessage(msg));
  }

  // ── outbound ─────────────────────────────────────────────────────────────

  /** Call a method on the other side and await its JSON-RPC response. */
  public call(method: string, params?: any, timeoutMs?: number): Promise<any> {
    if (this.closed) {
      return Promise.reject(
        new RpcError(AwErrorCode.DISPOSED, 'bus is closed: cannot call ' + method)
      );
    }
    const id = nextRpcId();
    const timeout = timeoutMs === undefined ? this.defaultTimeoutMs : timeoutMs;
    return new Promise<any>((resolve, reject) => {
      let timer: any = null;
      if (timeout > 0) {
        timer = setTimeout(() => {
          const p = this.pending.get(id);
          if (p) {
            this.pending.delete(id);
            reject(new RpcError(AwErrorCode.TIMEOUT, method + ' timed out after ' + timeout + 'ms'));
          }
        }, timeout);
        if (typeof (timer as any).unref === 'function') (timer as any).unref();
      }
      this.pending.set(id, { resolve, reject, timer, method });
      this.post(makeRequest(id, method, params));
    });
  }

  /** Fire-and-forget notification; no id, no reply, no rejection. */
  public notify(method: string, params?: any): void {
    if (this.closed) return;
    this.post(makeNotification(method, params));
  }

  // ── inbound ──────────────────────────────────────────────────────────────

  /** Expose a handler so the other side can `call()` us. */
  public handle(method: string, fn: RpcHandler): void {
    if (this.handlers.has(method)) {
      throw new Error('RPC method already registered: ' + method);
    }
    this.handlers.set(method, fn);
  }

  /** Remove a previously registered handler. */
  public unhandle(method: string): void {
    this.handlers.delete(method);
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    const dead = new RpcError(AwErrorCode.TRANSPORT_CLOSED, 'transport closed');
    this.pending.forEach((p) => {
      if (p.timer) clearTimeout(p.timer);
      p.reject(dead);
    });
    this.pending.clear();
    this.handlers.clear();
    if (typeof this.transport.close === 'function') {
      try {
        this.transport.close();
      } catch (err) {
        this.log('transport.close error: ' + String(err));
      }
    }
  }

  public get isClosed(): boolean {
    return this.closed;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private post(message: RpcRequest): void {
    try {
      this.transport.post(message);
    } catch (err) {
      const id = (message as RpcRequest).id;
      if (typeof id === 'number') {
        const p = this.pending.get(id);
        if (p) {
          this.pending.delete(id);
          if (p.timer) clearTimeout(p.timer);
          p.reject(new RpcError(AwErrorCode.TRANSPORT_CLOSED, String(err)));
        }
      }
    }
  }

  private onMessage(raw: any): void {
    if (this.closed || raw === null || typeof raw !== 'object') return;
    if (isRpcResponse(raw)) {
      this.onResponse(raw);
      return;
    }
    if (isRpcRequest(raw)) {
      // Requests on the wire are answered with the same id type we received.
      const id: RpcId = raw.id === undefined ? null : raw.id;
      if (id === null || id === undefined) {
        // notification: no reply
        this.dispatch(raw, null).catch((err) => this.log('notify ' + raw.method + ' failed: ' + String(err)));
      } else {
        this.dispatch(raw, id).then(
          (result) => this.post(makeResult(id, result) as any),
          (err) => {
            const e = rpcErrorFrom(err);
            this.post(makeError(id, e.code, e.message, e.data) as any);
          }
        );
      }
    }
  }

  private onResponse(res: RpcResponse): void {
    const id = typeof res.id === 'number' ? res.id : -1;
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (p.timer) clearTimeout(p.timer);
    if (res.error) {
      p.reject(new RpcError(res.error.code, res.error.message, res.error.data));
    } else {
      p.resolve(res.result);
    }
  }

  private async dispatch(req: RpcRequest, _id: RpcId): Promise<any> {
    const fn = this.handlers.get(req.method);
    if (!fn) {
      throw new RpcError(
        RpcErrorCode.METHOD_NOT_FOUND,
        'method not found: ' + req.method
      );
    }
    return fn(req.params);
  }
}

/** In-process loopback transport: wires two buses back-to-back. */
export class LoopbackTransport implements Transport {
  private peer: ((m: any) => void) | null = null;
  private subscriber: ((m: any) => void) | null = null;
  private readonly queue: any[] = [];
  private flushed = false;
  private readonly async: boolean;

  constructor(opts: { async?: boolean } = {}) {
    this.async = opts.async !== false;
  }

  /** Pair two loopbacks so messages posted on one arrive on the other. */
  public static pair(a: LoopbackTransport, b: LoopbackTransport): void {
    a.peer = (m) => b.deliver(m);
    b.peer = (m) => a.deliver(m);
    a.flush();
    b.flush();
  }

  public post(message: any): void {
    if (!this.peer) {
      // Buffer until a peer is attached so construction order never matters.
      this.queue.push(message);
      return;
    }
    if (this.async) {
      const peer = this.peer;
      Promise.resolve().then(() => peer(message));
    } else {
      this.peer(message);
    }
  }

  public subscribe(handler: (m: any) => void): () => void {
    this.subscriber = handler;
    this.flushed = true;
    return () => {
      if (this.subscriber === handler) this.subscriber = null;
    };
  }

  private deliver(m: any): void {
    if (this.subscriber) this.subscriber(m);
  }

  private flush(): void {
    if (this.peer && this.queue.length) {
      const queued = this.queue.splice(0, this.queue.length);
      for (const m of queued) this.post(m);
    }
  }
}
