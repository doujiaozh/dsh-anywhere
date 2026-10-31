/**
 * aw_edge_llm · api.ts — one tiny object for "run this small model here".
 *
 * The point of this package is the 5MB class of nets: a mobile OCR model, a
 * sentiment classifier, a face detector. None of them need a GPU; all of them
 * run on the same ONNX Runtime Web that runs in a browser tab.
 */

import { loadBytes } from '@anywhere/core';
import { loadOrt, OrtBackend, OrtHandle, OrtLoadOptions } from './ort';
import { EdgeModel, ImagePrep, PredictResult, SessionOptions } from './model';

/**
 * Curated tiny-model registry. `kind` selects the built-in runner; supply your
 * own ONNX URL + labels and `kind:'custom'` and everything still works.
 */
export interface ModelSpec {
  id: string;
  /** Where the .onnx bytes live: http(s) URL, local path, or base64 data URI. */
  url?: string;
  /** Human label. */
  title?: string;
  /** Approximate size in MB (for display/planning on dial-up hosts). */
  sizeMB?: number;
  /** Input spec for vision models. */
  image?: ImagePrep;
  /** Class labels for classifier outputs. */
  labels?: string[];
  /** Expected input kind. */
  kind?: 'image' | 'tokens' | 'custom';
}

export const MODEL_REGISTRY: Record<string, ModelSpec> = {
  'mnist-digits': {
    id: 'mnist-digits',
    title: 'MNIST digit classifier (~12MB WASM sanity model)',
    sizeMB: 12,
    kind: 'image',
    image: { width: 28, height: 28, color: 'gray', mean: [0.1307], std: [0.3081] },
    labels: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'],
  },
  squeezenet: {
    id: 'squeezenet',
    title: 'SqueezeNet 1.1 ImageNet classifier (~5MB)',
    sizeMB: 5,
    kind: 'image',
    image: { width: 224, height: 224, mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] },
  },
  'sentiment-mini': {
    id: 'sentiment-mini',
    title: 'Slot for a tiny text classifier (bring your own .onnx)',
    sizeMB: 1,
    kind: 'tokens',
  },
};

export interface EdgeLlmOptions {
  ort?: OrtLoadOptions;
  /** Default backend hint. */
  backend?: OrtBackend;
  /** Local override for a registry model id → path/URL. */
  modelPaths?: Record<string, string>;
}

export class EdgeLlm {
  private ortPromise: Promise<OrtHandle> | null = null;
  private ortOptions: OrtLoadOptions;
  private modelPaths: Record<string, string>;
  private models = new Map<string, Promise<EdgeModel>>();

  constructor(options: EdgeLlmOptions = {}) {
    this.ortOptions = Object.assign({}, options.ort || {}, { backend: options.backend || options.ort?.backend || 'wasm' });
    this.modelPaths = options.modelPaths || {};
  }

  /** Boot ONNX Runtime Web (cached once). */
  public runtime(): Promise<OrtHandle> {
    if (!this.ortPromise) this.ortPromise = loadOrt(this.ortOptions);
    return this.ortPromise;
  }

  /** Register or replace a model spec (e.g. your own OCR net). */
  public registerModel(spec: ModelSpec): void {
    MODEL_REGISTRY[spec.id] = spec;
    this.models.delete(spec.id);
  }

  /** Point a registry model at a local copy so it never hits the network. */
  public aliasLocal(modelId: string, path: string): void {
    this.modelPaths[modelId] = path;
  }

  /**
   * Load (and cache) a model. Accepts a registry id, a spec, or a raw
   * URL/path/base64 string. Returns a live `EdgeModel`.
   */
  public async load(id: string | ModelSpec | string, sessionOptions?: SessionOptions): Promise<EdgeModel> {
    const spec = specFrom(id, this.modelPaths);
    const key = spec.url || spec.id || String(id);
    const hit = this.models.get(key);
    if (hit) return hit;

    const promise = (async () => {
      const handle = await this.runtime();
      const url = spec.url;
      if (!url) {
        throw new Error(
          'Anywhere EdgeLLM: model has no url. Register one with registerModel({id,url}) or pass an ONNX path/URL directly.'
        );
      }
      return EdgeModel.create(handle, url, sessionOptions);
    })();
    this.models.set(key, promise);
    try {
      return await promise;
    } catch (e) {
      this.models.delete(key);
      throw e;
    }
  }

  /** Preload raw model bytes (handy from a worker or an embedded payload). */
  public async loadBytes(id: string | ModelSpec, bytes: Uint8Array, sessionOptions?: SessionOptions): Promise<EdgeModel> {
    const spec = specFrom(id, this.modelPaths);
    const handle = await this.runtime();
    const model = await EdgeModel.create(handle, bytes, sessionOptions);
    this.models.set(spec.url || spec.id || String(id), Promise.resolve(model));
    return model;
  }

  /** Vision one-liner: pixels → predictions for a registry/aliased model. */
  public async predictImage(
    modelId: string | ModelSpec,
    pixels: Uint8Array | Uint8ClampedArray,
    prepOverride?: Partial<ImagePrep>
  ): Promise<PredictResult> {
    const spec = specFrom(modelId, this.modelPaths);
    if (!spec.image) throw new Error('Model "' + (spec.id || modelId) + '" has no image spec');
    const model = await this.load(spec);
    const prep: ImagePrep = Object.assign({}, spec.image || {}, prepOverride || {});
    return model.predictImage(pixels, prep, spec.labels);
  }

  /** Fetch model bytes only (for cache warming / progress bars). */
  public async fetchBytes(modelId: string | ModelSpec): Promise<Uint8Array> {
    const spec = specFrom(modelId, this.modelPaths);
    if (!spec.url) throw new Error('No url for model "' + (spec.id || modelId) + '"');
    return loadBytes(spec.url);
  }

  /** Drop a cached session (memory matters on 8GB boxes). */
  public async unload(modelId: string | ModelSpec): Promise<void> {
    const spec = specFrom(modelId, this.modelPaths);
    const key = spec.url || spec.id || String(modelId);
    const hit = this.models.get(key);
    if (hit) {
      const model = await hit;
      await model.release();
      this.models.delete(key);
    }
  }

  public async dispose(): Promise<void> {
    const keys = Array.from(this.models.keys());
    for (const k of keys) {
      const m = await this.models.get(k)!;
      await m.release();
    }
    this.models.clear();
  }
}

function specFrom(id: string | ModelSpec, aliases: Record<string, string>): ModelSpec {
  if (typeof id === 'string') {
    const registered = MODEL_REGISTRY[id];
    const alias = aliases[id];
    if (!registered && !alias) {
      // Treat the string itself as a model location.
      return { id, url: id, kind: 'custom' };
    }
    if (registered && alias) return Object.assign({}, registered, { url: alias });
    if (registered) return Object.assign({}, registered, { url: registered.url || guessUrlFor(registered, id) });
    return { id, url: alias };
  }
  return id;
}

/** Registry entries without a fixed CDN get the model from the environment. */
function guessUrlFor(spec: ModelSpec, id: string): string {
  if (spec.url) return spec.url;
  throw new Error(
    'Model "' + id + '" has no baked-in URL. Drop the .onnx somewhere reachable and call aliasLocal("' + id + '", path).'
  );
}

/** Singleton convenience accessor. */
let _shared: EdgeLlm | null = null;
export function edgeLlm(options?: EdgeLlmOptions): EdgeLlm {
  if (!_shared) _shared = new EdgeLlm(options || {});
  return _shared;
}
