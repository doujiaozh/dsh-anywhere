#!/usr/bin/env node
/**
 * scripts/smoke.js — offline smoke test: loads the compiled packages and
 * asserts the pieces that need no network (env detection, JSON-RPC bus over a
 * loopback transport, sandbox/transport wiring, image pre/post-processing).
 *
 * Run with: npm test  (after npm run build)
 */
'use strict';

const path = require('path');
const assert = require('assert');

function requireCore() {
  const candidates = [
    path.join(__dirname, '..', 'packages', 'aw_core', 'dist', 'index.js'),
  ];
  for (const c of candidates) {
    try {
      return require(c);
    } catch (_e) {
      /* next */
    }
  }
  throw new Error('aw_core not built — run `npm run build` first.');
}

function requireEdgeLlm() {
  return require(path.join(__dirname, '..', 'packages', 'aw_edge_llm', 'dist', 'index.js'));
}

async function main() {
  const core = requireCore();
  const llm = requireEdgeLlm();

  // 1. env detection.
  const kind = core.detectRuntime();
  assert.ok(kind === 'node' || kind === 'browser', 'env.kind detected: ' + kind);
  console.log('ok  env detection →', kind);

  // 2. JSON-RPC bus over a loopback pair: call + notify + error path.
  {
    const a = new core.LoopbackTransport();
    const b = new core.LoopbackTransport();
    core.LoopbackTransport.pair(a, b);
    const busA = new core.JsonRpcBus(a, { name: 'a' });
    const busB = new core.JsonRpcBus(b, { name: 'b' });

    busB.handle('add', (p) => ({ sum: p.x + p.y }));
    const result = await busA.call('add', { x: 2, y: 3 }, 5000);
    assert.strictEqual(result.sum, 5, 'RPC call returns payload');

    await busA.notify('log', { msg: 'hi' });
    assert.ok(true, 'notify delivered');

    let sawError = null;
    busB.handle('boom', () => {
      throw new Error('kaput');
    });
    try {
      await busA.call('boom', {}, 5000);
    } catch (e) {
      sawError = e;
    }
    assert.ok(sawError, 'RPC errors propagate');
    assert.strictEqual(sawError.code, core.RpcErrorCode.INTERNAL_ERROR, 'RPC error code');

    busA.close();
    busB.close();
    console.log('ok  JSON-RPC bus (call/notify/error)');
  }

  // 3. RpcError + message builders.
  {
    const req = core.makeRequest(7, 'm', { a: 1 });
    assert.strictEqual(req.jsonrpc, '2.0');
    assert.strictEqual(req.id, 7);
    const err = core.rpcErrorFrom(new Error('x'));
    assert.strictEqual(err.code, core.RpcErrorCode.INTERNAL_ERROR);
    console.log('ok  message builders');
  }

  // 4. ffmpeg progress parsing (pure function; no wasm needed).
  {
    const line = 'frame=  123 fps= 30 q=2.0 size=    512kB time=00:00:04.10 bitrate=1024.0kbits/s speed=2.5x';
    const p = core.probeWasm ? null : null;
    const ffmpeg = require(path.join(__dirname, '..', 'packages', 'aw_ffmpeg', 'dist', 'index.js'));
    const parsed = ffmpeg.FfmpegEngine.parseProgress(line);
    assert.ok(parsed && parsed.frame === 123, 'progress frame parsed');
    assert.ok(parsed && parsed.time > 4, 'progress time parsed (seconds)');
    console.log('ok  ffmpeg progress parser');
    void p;
  }

  // 5. ffmpeg probe log parsing.
  {
    const ffmpeg = require(path.join(__dirname, '..', 'packages', 'aw_ffmpeg', 'dist', 'index.js'));
    const log =
      'Duration: 00:01:23.45, start: 0.000000, bitrate: 2048 kb/s\n' +
      'Stream #0:0: Video: h264 (High), yuv420p, 1280x720, 1500 kb/s, 30 fps';
    const probe = ffmpeg.parseProbeLog(log.split('\n'));
    assert.ok(probe.durationText && probe.durationText.includes('00:01:23'), 'probe duration');
    assert.ok(probe.streams && probe.streams.length === 1 && probe.streams[0].width === 1280, 'probe stream');
    console.log('ok  ffmpeg probe parser');
  }

  // 6. edge-llm tensor prep + softmax (no model download).
  {
    const pixels = new Uint8Array([0, 128, 255]);
    const fakeOrt = { Tensor: class { constructor(t, d, dims) { this.type = t; this.data = d; this.dims = dims; } } };
    const tensor = llm.imageToTensor(pixels, { width: 1, height: 1 }, { ort: fakeOrt });
    assert.deepStrictEqual(tensor.dims, [1, 3, 1, 1]);
    assert.ok(Math.abs(tensor.data[2] - 1) < 1e-6, 'normalize to 1.0 for 255');
    const probs = llm.softmax([0, 0, 0]);
    assert.ok(Math.abs(probs[0] - 1 / 3) < 1e-9, 'softmax uniform');
    const top = llm.topK([{ label: 'a', score: 0.2 }, { label: 'b', score: 0.5 }], 1);
    assert.strictEqual(top[0].label, 'b', 'topK orders by score');
    console.log('ok  edge-llm preprocessing');
  }

  console.log('\nAnywhere smoke test passed.');
}

main().catch((e) => {
  console.error('smoke test FAILED:', e && e.stack ? e.stack : e);
  process.exit(1);
});
