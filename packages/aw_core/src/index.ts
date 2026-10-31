/**
 * @anywhere/core — public surface.
 *
 * "Load anything, talk to anything, anywhere."
 */

export {
  detectRuntime,
  isBrowser,
  isNode,
  isFileSystemPath,
  isHttpUrl,
  loadBytes,
  nodeFs,
  nodePath,
  nodeRequire,
  resolveFilePath,
  RuntimeKind,
} from './env';

export {
  AwErrorCode,
  isRpcRequest,
  isRpcResponse,
  makeError,
  makeNotification,
  makeRequest,
  makeResult,
  nextRpcId,
  RpcError,
  RpcErrorCode,
  rpcErrorFrom,
  RpcErrorBody,
  RpcId,
  RpcMessage,
  RpcRequest,
  RpcResponse,
} from './rpc';

export {
  BusOptions,
  JsonRpcBus,
  LoopbackTransport,
  RpcHandler,
  Transport,
} from './bus';

export {
  createMinimalWasiImports,
  isWasiExit,
  tryNodeWasi,
  WasiExit,
} from './wasi-min';

export {
  createLenientImports,
  EmscriptenFactory,
  loader,
  LoadOptions,
  LoadedModule,
  loader as defaultLoader,
  probeWasm,
  WasmLoader,
  WasmMode,
  WasmSource,
} from './loader';

export {
  Asset,
  AssetCache,
  AssetCacheOptions,
  sha256Buffer,
} from './io';

export {
  BrowserWorkerTransport,
  handshake,
  NodeWorkerTransport,
  serveWorker,
  ServeWorkerOptions,
  spawnWorkerRpc,
} from './worker';

export {
  SandboxOptions,
  WasmSandbox,
} from './sandbox';

export const AW_CORE_VERSION = '0.1.0';
