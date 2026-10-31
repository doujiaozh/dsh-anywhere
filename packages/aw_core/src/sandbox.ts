/**
 * aw_core · sandbox.ts — a loaded module + a JSON-RPC session, one object.
 *
 * `WasmSandbox` is the convenience surface most consumers want: load bytes,
 * wire the bus, expose host callbacks, call into the guest, dispose.
 * With the default loopback transport the sandbox is a pure in-memory session
 * (the Pyodide pattern); pass a worker transport for real thread isolation.
 */

import { JsonRpcBus, LoopbackTransport, RpcHandler, Transport } from './bus';
import { LoadOptions, loader, LoadedModule } from './loader';

export interface SandboxOptions {
  /** Reuse an already-loaded module, or hand load options to the loader. */
  module: LoadedModule | LoadOptions;
  /** Custom transport (worker/main-thread). Default: a loopback pair. */
  transport?: Transport;
  /** Host methods the sandbox may call. */
  methods?: Record<string, RpcHandler>;
  /** Bus label for logs. */
  name?: string;
  /** `call()` default timeout override (ms). */
  timeoutMs?: number;
}

export class WasmSandbox {
  public readonly bus: JsonRpcBus;
  public readonly module: LoadedModule;
  /** The far end of the default loopback pair; null when a custom transport is used. */
  public readonly remoteBus: JsonRpcBus | null;

  private constructor(bus: JsonRpcBus, mod: LoadedModule, remoteBus: JsonRpcBus | null) {
    this.bus = bus;
    this.module = mod;
    this.remoteBus = remoteBus;
  }

  public static async create(options: SandboxOptions): Promise<WasmSandbox> {
    const mod: LoadedModule =
      (options.module as LoadedModule).instance !== undefined
        ? (options.module as LoadedModule)
        : await loader.load(options.module as LoadOptions);

    let bus: JsonRpcBus;
    let remoteBus: JsonRpcBus | null = null;

    if (options.transport) {
      bus = new JsonRpcBus(options.transport, {
        name: options.name || 'aw-sandbox',
        defaultTimeoutMs: options.timeoutMs,
      });
    } else {
      const hostSide = new LoopbackTransport({ async: true });
      const guestSide = new LoopbackTransport({ async: true });
      LoopbackTransport.pair(hostSide, guestSide);
      bus = new JsonRpcBus(hostSide, {
        name: options.name || 'aw-sandbox',
        defaultTimeoutMs: options.timeoutMs,
      });
      remoteBus = new JsonRpcBus(guestSide, {
        name: (options.name || 'aw') + ':remote',
      });
    }

    if (options.methods) {
      for (const name of Object.keys(options.methods)) bus.handle(name, options.methods[name]);
    }
    return new WasmSandbox(bus, mod, remoteBus);
  }

  /** Call a method implemented inside the sandbox. */
  public call(method: string, params?: any, timeoutMs?: number): Promise<any> {
    return this.bus.call(method, params, timeoutMs);
  }

  /** Let the sandbox call a host method. */
  public expose(method: string, fn: RpcHandler): void {
    this.bus.handle(method, fn);
  }

  /** The guest's linear memory, when it exports one. */
  public memory(): WebAssembly.Memory | null {
    return (this.module.exports as any).memory || null;
  }

  /** Raw export table of the linked instance. */
  public exports(): Record<string, any> {
    return this.module.exports;
  }

  /** Attach a JSON-RPC peer to the far end of the loopback (in-process runtimes). */
  public attachRemote(handlers: Record<string, RpcHandler>): JsonRpcBus {
    if (!this.remoteBus) {
      throw new Error('attachRemote() needs the default loopback transport');
    }
    for (const name of Object.keys(handlers)) this.remoteBus.handle(name, handlers[name]);
    return this.remoteBus;
  }

  public dispose(): void {
    this.bus.close();
    if (this.remoteBus) this.remoteBus.close();
  }
}
