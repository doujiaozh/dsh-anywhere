/**
 * aw_edge_llm · model.ts — a tiny ONNX session with batteries included.
 *
 * Most edge models (a 5MB OCR net, a sentiment classifier, a small object
 * detector) share the same choreography: normalize pixels into NCHW floats,
 * run the graph, then softmax / top-k the logits. This module is that
 * choreography, so callers stay two lines long.
 */

import { loadBytes } from '@anywhere/core';
import { OrtHandle } from './ort';

export interface SessionOptions {
  /** Override the registered input name (auto-detected from the model by default). */
  inputName?: string;
  /** Override the registered output name (auto-detected from the model by default). */
  outputName?: string;
  executionProviders?: string[];
  graphOptimizationLevel?: string;
  intraOpNumThreads?: number;
}

export interface ImagePrep {
  /** Target width/height in pixels. */
  width: number;
  height: number;
  /** Float range: [0,1] or normalised mean/std (channel-major arrays). */
  mean?: number[];
  std?: number[];
  /** 'chw' (most ONNX vision nets) or 'hwc'. Default 'chw'. */
  layout?: 'chw' | 'hwc';
  /** Source colour space. Default 'rgb'. */
  color?: 'rgb' | 'bgr' | 'gray';
}

export interface PredictResult {
  /** Raw graph output as typed arrays/objects from ort. */
  raw: Record<string, any>;
  /** If `outputName` was scalar logits: label probabilities. */
  probabilities?: Array<{ label: string; score: number }>;
  /** Top-k of `probabilities`. */
  top?: Array<{ label: string; score: number }>;
  /** Milliseconds spent inside the graph. */
  elapsedMs: number;
}

export class EdgeModel {
  public readonly ort: OrtHandle;
  public readonly session: any;
  public readonly inputName: string;
  public readonly outputName: string;

  constructor(ort: OrtHandle, session: any, inputName: string, outputName: string) {
    this.ort = ort;
    this.session = session;
    this.inputName = inputName;
    this.outputName = outputName;
  }

  /** Build from a file path / URL / base64 data URI / raw bytes. */
  public static async create(handle: OrtHandle, source: string | Uint8Array, options: SessionOptions = {}): Promise<EdgeModel> {
    const data =
      source instanceof Uint8Array ? source : await loadBytes(typeof source === 'string' ? source : String(source));
    const session = await handle.ort.InferenceSession.create(data, {
      executionProviders: options.executionProviders || [handle.backend],
      graphOptimizationLevel: options.graphOptimizationLevel || 'all',
      intraOpNumThreads: options.intraOpNumThreads || 1,
    });

    const inputName = options.inputName || (session.inputNames && session.inputNames[0]) || 'input';
    const outputName = options.outputName || (session.outputNames && session.outputNames[0]) || 'output';
    return new EdgeModel(handle, session, inputName, outputName);
  }

  /** Run the graph with raw named feeds. */
  public async run(feeds: Record<string, any>): Promise<Record<string, any>> {
    const results = await this.session.run(feeds);
    return results as Record<string, any>;
  }

  /**
   * Vision shortcut: pixels (RGBA or RGB interleaved) → NCHW tensor → logits →
   * probabilities + top-k. `labels` aligns output indices to names.
   */
  public async predictImage(
    pixels: Uint8Array | Uint8ClampedArray,
    prep: ImagePrep,
    labels?: string[]
  ): Promise<PredictResult> {
    const t0 = Date.now();
    const tensor = imageToTensor(pixels, prep, this.ort);
    const feeds: Record<string, any> = {};
    feeds[this.inputName] = tensor;
    const raw = await this.run(feeds);
    const out = raw[this.outputName];

    const probabilities = tryProbabilities(out, labels);
    const top = probabilities ? topK(probabilities, 5) : undefined;
    return { raw, probabilities, top, elapsedMs: Date.now() - t0 };
  }

  /** Text shortcut: a tensor of token ids already shaped by the caller. */
  public async predictTokens(
    ids: number[] | number[][] | Int32Array | BigInt64Array,
    shape: number[],
    idsName?: string
  ): Promise<PredictResult> {
    const t0 = Date.now();
    const flat = Array.isArray(ids) ? (ids as any[]).flat(Infinity) : Array.from(ids as any);
    const data = Int32Array.from(flat.map((v: any) => (typeof v === 'bigint' ? Number(v) : v)));
    const tensor = new this.ort.ort.Tensor('int32', data, shape);
    const feeds: Record<string, any> = {};
    feeds[idsName || this.inputName] = tensor;
    const raw = await this.run(feeds);
    const out = raw[this.outputName];
    const probabilities = tryProbabilities(out);
    const top = probabilities ? topK(probabilities, 5) : undefined;
    return { raw, probabilities, top, elapsedMs: Date.now() - t0 };
  }

  public get inputNames(): string[] {
    return (this.session.inputNames || []) as string[];
  }
  public get outputNames(): string[] {
    return (this.session.outputNames || []) as string[];
  }

  public async release(): Promise<void> {
    if (typeof this.session.release === 'function') await this.session.release();
  }
}

/** Convert interleaved RGB(A)/gray pixels into a normalized float tensor. */
export function imageToTensor(pixels: Uint8Array | Uint8ClampedArray, prep: ImagePrep, handle: OrtHandle): any {
  const channels = prep.color === 'gray' ? 1 : 3;
  const layout = prep.layout || 'chw';
  const mean = prep.mean || [0, 0, 0];
  const std = prep.std || [1, 1, 1];
  const { width: w, height: h } = prep;

  // Source may be RGBA (4), RGB (3) or gray (1) interleaved.
  const srcC = pixels.length === w * h ? 1 : pixels.length / (w * h);
  if (srcC !== 1 && srcC !== 3 && srcC !== 4) {
    throw new Error(`imageToTensor: unexpected pixel count ${pixels.length} for ${w}x${h}`);
  }

  const data = new Float32Array(w * h * channels);
  const bgr = prep.color === 'bgr';
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const srcIdx = (y * w + x) * srcC;
      const dstIdxYY = y * w + x;
      for (let c = 0; c < channels; c++) {
        const srcChannel = srcC === 1 ? 0 : bgr ? 2 - c : c;
        const raw = pixels[srcIdx + srcChannel] / 255;
        const v = (raw - mean[c]) / std[c];
        if (layout === 'chw') {
          data[c * w * h + dstIdxYY] = v;
        } else {
          data[dstIdxYY * channels + c] = v;
        }
      }
    }
  }

  const dims = layout === 'chw' ? [1, channels, h, w] : [1, h, w, channels];
  return new handle.ort.Tensor('float32', data, dims);
}

/** Softmax over the last axis of a float32/float64 output tensor (or array). */
export function softmax(values: number[] | Float32Array | Float64Array): number[] {
  const arr: number[] = Array.from(values);
  let max = Number.NEGATIVE_INFINITY;
  for (const v of arr) if (v > max) max = v;
  const exps = arr.map((v) => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

export function topK(probabilities: Array<{ label: string; score: number }>, k: number) {
  return probabilities.slice().sort((a, b) => b.score - a.score).slice(0, k);
}

/** Recognise class-logit outputs of shape [1,C] or [C] and turn them into labels+scores. */
export function tryProbabilities(out: any, labels?: string[]): Array<{ label: string; score: number }> | undefined {
  if (!out) return undefined;
  const arr: any = out.data ? out.data : out;
  let flat: any[] | null = null;
  let dims: number[] | null = null;
  if (out.dims && Array.isArray(out.dims)) dims = out.dims as number[];
  if (arr && typeof arr.length === 'number') {
    flat = Array.from(arr as any);
  } else if (out && typeof out.get === 'function') {
    // ort tensors expose .data; Map-shaped outputs shouldn't reach here.
    return undefined;
  }
  if (!flat) return undefined;

  // 2-D [1,C]: take row 0 when the first dim is 1.
  let scores = flat;
  if (dims && dims.length === 2 && dims[0] === 1) {
    scores = flat.slice(0, dims[1]);
  } else if (dims && dims.length === 2) {
    scores = flat.slice(0, dims[1]);
  }

  if (scores.length > 64) return undefined; // not a classifier, don't guess
  const probs = softmax(scores);
  return probs.map((score, i) => ({
    label: labels && labels[i] !== undefined ? labels[i] : String(i),
    score,
  }));
}
