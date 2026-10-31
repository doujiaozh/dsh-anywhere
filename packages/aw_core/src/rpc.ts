/**
 * aw_core · rpc.ts — JSON-RPC 2.0 protocol primitives.
 *
 * Anywhere's entire host⇄wasm conversation is JSON-RPC 2.0 over a transport.
 * Keep the wire format boring and standard so any language runtime compiled
 * to WASM can speak it (Emscripten, Pyodide, Rust+WASI, AssemblyScript, …).
 */

export type RpcId = number | string | null;

export interface RpcRequest {
  jsonrpc: '2.0';
  id?: RpcId;
  method: string;
  params?: any;
}

export interface RpcErrorBody {
  code: number;
  message: string;
  data?: any;
}

export interface RpcResponse {
  jsonrpc: '2.0';
  id: RpcId;
  result?: any;
  error?: RpcErrorBody;
}

export type RpcMessage = RpcRequest | RpcResponse;

/** Standard JSON-RPC error codes. */
export const RpcErrorCode = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

/** Anywhere extension codes (>= -32000 are reserved for implementation use). */
export const AwErrorCode = {
  TRANSPORT_CLOSED: -32001,
  TIMEOUT: -32002,
  DISPOSED: -32003,
  ASSET_MISSING: -32004,
} as const;

export function isRpcRequest(msg: any): msg is RpcRequest {
  return (
    msg !== null &&
    typeof msg === 'object' &&
    msg.jsonrpc === '2.0' &&
    typeof msg.method === 'string'
  );
}

export function isRpcResponse(msg: any): msg is RpcResponse {
  return (
    msg !== null &&
    typeof msg === 'object' &&
    msg.jsonrpc === '2.0' &&
    (msg.result !== undefined || msg.error !== undefined) &&
    msg.id !== undefined
  );
}

export function makeRequest(id: RpcId, method: string, params?: any): RpcRequest {
  const req: RpcRequest = { jsonrpc: '2.0', id, method };
  if (params !== undefined) req.params = params;
  return req;
}

export function makeNotification(method: string, params?: any): RpcRequest {
  const req: RpcRequest = { jsonrpc: '2.0', id: null, method };
  if (params !== undefined) req.params = params;
  return req;
}

export function makeResult(id: RpcId, result: any): RpcResponse {
  return { jsonrpc: '2.0', id, result: result === undefined ? null : result };
}

export function makeError(id: RpcId, code: number, message: string, data?: any): RpcResponse {
  const err: RpcErrorBody = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: '2.0', id, error: err };
}

/** A round trippable Error carrying an RPC error code. */
export class RpcError extends Error {
  public readonly code: number;
  public readonly data: any;
  constructor(code: number, message: string, data?: any) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
  toJSON(): RpcErrorBody {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data };
  }
}

export function rpcErrorFrom(err: unknown): RpcError {
  if (err instanceof RpcError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new RpcError(RpcErrorCode.INTERNAL_ERROR, message);
}

/** Monotonic request id source; safe across bus instances in one process. */
let _nextId = 1;
export function nextRpcId(): number {
  const id = _nextId;
  _nextId += 1;
  if (_nextId > 0x7fffffff) _nextId = 1;
  return id;
}
