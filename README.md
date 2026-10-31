# Anywhere

> **Anywhere：打破平台的枷锁，WASM 即是未来。**

**Anywhere** 是一个跨平台、零原生编译的 WASM 执行框架。它把音视频处理、Python 数据清洗、边缘模型推理这些"重型工具"，统统装进 WebAssembly 沙盒里——一次编译，处处运行：

- 🚫 **无 C++ 编译环境** —— 不需要 MSVC、GCC、make，不编译任何原生模块；
- 🪟 **无操作系统门槛** —— Win7、极低配机器、乃至浏览器标签页，同一份代码；
- 🔌 **宿主零侵入** —— 所有计算在 WASM 虚拟文件系统内完成，宿主只收发字节。

Anywhere 是 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek Harness) 的底层能力插件集，也可独立使用。

## 能力矩阵

| 包 | 能力 | 底层 WASM 运行时 |
| ---- | ---- | ---- |
| `@anywhere/core` | 统一 WASM 加载器 · JSON-RPC 双向总线 · 沙盒 · Worker 传输 | 原生 `WebAssembly` + `node:wasi` 回落纯 JS WASI shim |
| `@anywhere/ffmpeg` | 视频转码 · 音频提取 · 视频截帧 · 媒体探测 | ffmpeg.wasm（Emscripten） |
| `@anywhere/python` | 运行 Python 脚本 · numpy/pandas 数据清洗 | Pyodide（CPython WASM 版） |
| `@anywhere/edge-llm` | 边缘端微型模型推理（5MB 级 OCR / 分类器） | onnxruntime-web |
| `@anywhere/cli` | `anywhere run ffmpeg \| python \| llm` 统一入口 | — |

## 快速开始

### 安装

```bash
# 从源码（本仓库）
git clone <your-fork-url> dsh-anywhere
cd dsh-anywhere
npm install
npm run build          # tsc -b，全部纯 TS 编译，无原生步骤
```

### 命令行

```bash
# 视频转码（本地文件自动暂存进 WASM 虚拟 FS，结果写回当前目录）
anywhere run ffmpeg -i input.mp4 -c:v libx264 -crf 28 output.mp4

# 提取音频
anywhere run ffmpeg -i input.mp4 -vn -q:a 2 output.mp3

# 视频截帧
anywhere run ffmpeg -i input.mp4 -ss 00:00:01 -frames:v 1 frame.png

# Python 脚本（Pyodide 自动联网拉取，首次约 ~10MB；之后缓存到本地）
anywhere run python script.py
anywhere run python -c "import numpy as np; print(np.arange(6).reshape(2,3).sum())"

# 边缘模型：列注册表 / 跑一张 PNG
anywhere run llm list
anywhere run llm mnist-digits --image digit.png
```

`anywhere --version` / `anywhere help` 即刻可用；`npm test` 跑离线冒烟测试（不联网、不下 wasm 镜像）。

### 编程式 API

```ts
import { WasmLoader } from '@anywhere/core';
import { ffmpeg } from '@anywhere/ffmpeg';
import { AwPython } from '@anywhere/python';
import { edgeLlm } from '@anywhere/edge-llm';

// 转码：字节进，字节出
const { data } = await ffmpeg().transcode(
  { name: 'in.mp4', data: bytes },
  { outputName: 'out.mp4', extraArgs: ['-crf', '28'] }
);

// Python 数据清洗（pandas 五件套：trim / dropna / 填充 / 去重 / 解析日期）
const py = new AwPython();
const { dataset, report } = await py.cleanDataset(rows, { fillMissing: 'mean' });

// 边缘推理：5MB 模型在 CPU 上跑
const llm = edgeLlm();
const { top } = await llm.predictImage('mnist-digits', imageBytes);
```

### 浏览器里同样能用

`@anywhere/core` 的传输层是纯 JSON-RPC：同一个 `JsonRpcBus`，在 Node 里背靠 `worker_threads`，在浏览器里背靠 Web Worker；加载器对 Emscripten / WASI / 裸模块三种导入表自动识别。所以同一段业务代码，Node 里跑得起来，`<script>` 里也跑得起来。

## 架构

```
┌─────────────────────────────────────────────────┐
│                  anywhere CLI                    │  ← 用户
├────────────┬────────────┬───────────┬───────────┤
│ aw_ffmpeg  │ aw_python  │aw_edge_llm│   …扩展    │  ← 能力插件
├────────────┴────────────┴───────────┴───────────┤
│   aw_core：WasmLoader · JsonRpcBus · Sandbox     │  ← 统一总线
│   Transport：Loopback / Node Worker / Browser    │
├─────────────────────────────────────────────────┤
│        WebAssembly（Emscripten · WASI）          │  ← 唯一运行时
├─────────────────────────────────────────────────┤
│   Windows · macOS · Linux · 浏览器（无 GPU 也行）  │  ← 任何宿主
└─────────────────────────────────────────────────┘
```

核心设计原则：

1. **一个加载器三种模块** —— `WasmLoader.load()` 嗅探导入表，自动选择 WASI（`node:wasi` 优先、纯 JS shim 回落）、Emscripten（驱动胶水工厂）或裸模块三种链接策略。
2. **对称总线** —— `JsonRpcBus` 让沙盒与宿主互为客户端/服务端：宿主可以 `call('transcode', …)`，沙盒也可以 `call('host:save', …)`。超时、错误码、通知一应俱全（JSON-RPC 2.0 + 三个扩展错误码）。
3. **零临时文件** —— ffmpeg 的输入输出全部走 Emscripten 内存文件系统（MEMFS），宿主磁盘上不落一帧中间产物。
4. **宽容链接** —— 缺失的导入函数在链接期不报错，只有真正被调用时才抛 `unlinked import`，兼容各路野生 wasm 构建产物。

## 目录结构

```
dsh-anywhere/
├─ packages/
│  ├─ aw_core/        加载器 · RPC 总线 · 沙盒 · Worker 传输 · WASI shim
│  ├─ aw_ffmpeg/      ffmpeg.wasm 引擎 + 高层 API + Worker 入口
│  ├─ aw_python/      Pyodide 运行时 + DataFrame 数据清洗
│  ├─ aw_edge_llm/    onnxruntime-web + 模型注册表 + 影像张量化
│  └─ aw_cli/         bin/anywhere.js + 子命令分发
├─ scripts/
│  ├─ clean.js        清理构建产物
│  └─ smoke.js        离线冒烟测试（npm test）
├─ tsconfig.json      项目引用（tsc -b 增量构建）
└─ package.json       workspaces: packages/*
```

## 开发

```bash
npm run build         # tsc -b（增量）
npm run build:force   # 全量重建
npm run dev           # tsc -b --watch
npm test              # 离线冒烟测试
npm run clean         # 清理 dist 与 *.tsbuildinfo
npm run clean all     # 连 node_modules 一起清
```

模型与大型 wasm 镜像（ffmpeg-core、Pyodide、ONNX runtime）按需从 CDN/npm 拉取并缓存在 `~/.anywhere/cache`，仓库本身不提交二进制——克隆即可读，`npm install && npm run build` 即可用。

## 局限与路线图

- **现在**：Win7/低配机上无 GPU 也能跑 5MB 级模型；ffmpeg 转码受单线程 wasm 限制（约 0.3–1x 实时）；Pyodide 冷启动 5–15s（缓存后 1–3s）。
- **接下来**：P-thread 多线程 ffmpeg-core、离线模型包（预置到 `assets/models/`）、Pyodide 持久化 venv、`run wasm <file>` 直接跑任意 WASI 二进制、VSCode 插件。
- **不做**：任何需要本地 C++ 工具链的东西。这是红线。

## 许可

MIT — 见 [LICENSE](./LICENSE)。

---

<p align="center"><em>Anywhere：打破平台的枷锁，WASM 即是未来。</em></p>
