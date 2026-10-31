/**
 * aw_ffmpeg · worker-entry.ts — run the engine on a worker thread.
 *
 * Compiled to `dist/worker-entry.js`. Host side:
 *
 *   const bus = await spawnWorkerRpc(require.resolve('@anywhere/ffmpeg/dist/worker-entry.js'), init);
 *   await bus.call('transcode', { input: { name:'in.mp4', data }, outputName:'out.mp4' });
 *
 * Same JSON-RPC surface as the main thread; the heavy wasm exec never blocks
 * your event loop.
 */

import { serveWorker } from '@anywhere/core';
import { AwFfmpeg, MediaFile, MediaProbe } from './api';
import { FfmpegEngine } from './engine';

let engine: AwFfmpeg | null = null;

function eng(): AwFfmpeg {
  if (!engine) engine = new AwFfmpeg(new FfmpegEngine({ core: { jsPath: 'npm' } }));
  return engine;
}

export interface WorkerCallPayload {
  input?: MediaFile;
  outputName?: string;
  extraArgs?: string[];
  format?: string;
  at?: number | string;
  args?: string[];
}

serveWorker({
  name: 'aw-ffmpeg-worker',
  init: (payload: any) => {
    // Core location may be passed in from the host, or defaults to npm.
    if (payload && payload.core) {
      engine = new AwFfmpeg(new FfmpegEngine({ core: payload.core }));
    } else {
      eng();
    }
    return { capabilities: ['transcode', 'extractAudio', 'captureFrame', 'probe', 'run', 'writeFile', 'readFile'] };
  },
  methods: {
    ping: () => ({ ok: true, time: Date.now() }),
    transcode: async (p: WorkerCallPayload) => {
      if (!p.input) throw new Error('transcode: input required');
      const out = await eng().transcode(p.input, p.outputName, p.extraArgs);
      return { output: mediaToPlain(out) };
    },
    extractAudio: async (p: WorkerCallPayload) => {
      if (!p.input) throw new Error('extractAudio: input required');
      const out = await eng().extractAudio(p.input, p.format as any, p.extraArgs);
      return { output: mediaToPlain(out) };
    },
    captureFrame: async (p: WorkerCallPayload) => {
      if (!p.input) throw new Error('captureFrame: input required');
      const out = await eng().captureFrame(p.input, p.at === undefined ? 0 : p.at, 'png');
      return { output: mediaToPlain(out) };
    },
    probe: async (p: WorkerCallPayload): Promise<MediaProbe> => {
      if (!p.input) throw new Error('probe: input required');
      return eng().probe(p.input);
    },
    run: async (p: WorkerCallPayload) => {
      if (!p.args) throw new Error('run: args required');
      return { exitCode: await eng().run(p.args) };
    },
    writeFile: async (p: WorkerCallPayload) => {
      if (!p.input) throw new Error('writeFile: input required');
      await eng().writeFile(p.input.name, p.input.data);
      return { ok: true };
    },
    readFile: async (p: { name?: string }) => {
      if (!p.name) throw new Error('readFile: name required');
      const data = await eng().readFile(p.name);
      return { name: p.name, data: mediaToPlain({ name: p.name, data }).data };
    },
  },
  dispose: () => {
    if (engine) engine.dispose();
    engine = null;
  },
});

function mediaToPlain(m: MediaFile): { name: string; data: Uint8Array } {
  const data = m.data instanceof Uint8Array ? m.data : new Uint8Array(m.data);
  return { name: m.name, data };
}
