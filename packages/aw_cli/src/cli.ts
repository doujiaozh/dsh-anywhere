/**
 * @anywhere/cli · cli.ts — `anywhere run ffmpeg|python|llm` on any host.
 *
 * The CLI is deliberately thin: parse argv, stage local files into the wasm
 * virtual filesystems, run the capability, pull results back out. Everything
 * heavy happens inside @anywhere/{ffmpeg,python,edge-llm}.
 */

import { isNode, loadBytes, nodeFs, nodePath, nodeRequire } from '@anywhere/core';
import { AwFfmpeg } from '@anywhere/ffmpeg';
import { AwPython } from '@anywhere/python';
import { EdgeLlm, MODEL_REGISTRY } from '@anywhere/edge-llm';

export const CLI_VERSION = '0.1.0';

export interface CliResult {
  code: number;
  output?: string;
}

export async function runCli(argv: string[]): Promise<CliResult> {
  const args = argv.slice(2);

  if (!args.length || args[0] === '-h' || args[0] === '--help' || args[0] === 'help') {
    return { code: 0, output: usage() };
  }
  if (args[0] === '-v' || args[0] === '--version' || args[0] === 'version') {
    return { code: 0, output: 'anywhere ' + CLI_VERSION };
  }

  if (args[0] !== 'run') {
    return { code: 1, output: 'anywhere: unknown command "' + args[0] + '".\n\n' + usage() };
  }
  if (!isNode()) {
    return { code: 1, output: 'anywhere: this CLI targets Node.js (browser builds embed @anywhere/* directly).' };
  }

  const capability = args[1];
  const rest = args.slice(2);
  switch (capability) {
    case 'ffmpeg':
      return runFfmpegCmd(rest);
    case 'python':
    case 'py':
      return runPythonCmd(rest);
    case 'llm':
    case 'model':
      return runLlmCmd(rest);
    default:
      return { code: 1, output: 'anywhere: unknown capability "' + capability + '". Try ffmpeg | python | llm.\n\n' + usage() };
  }
}

// ── ffmpeg ─────────────────────────────────────────────────────────────────

async function runFfmpegCmd(args: string[]): Promise<CliResult> {
  if (!args.length || args[0] === '-h' || args[0] === '--help') {
    return { code: 0, output: ffmpegUsage() };
  }
  if (args.includes('--version')) {
    const ffmpeg = new AwFfmpeg();
    const lines: string[] = [];
    ffmpeg.onLog((l) => lines.push(l));
    await ffmpeg.run(['-version']);
    return { code: 0, output: lines.join('\n') };
  }

  const fs = nodeFs()!;
  const staged: string[] = [];
  const outputs: string[] = [];

  // Stage any argv token that is an existing local file (inputs); record the
  // basename of the final non-flag token if it looks like an output path.
  const expanded = args.slice();
  for (let i = 0; i < expanded.length; i++) {
    const tok = expanded[i];
    if (tok.startsWith('-')) continue;
    if (fs.existsSync(tok) && fs.statSync(tok).isFile()) {
      const buffer = fs.readFileSync(tok);
      const basename = nodePath()!.basename(tok);
      expanded[i] = basename;
      staged.push(basename);
      // Hand the bytes to the engine via its virtual FS after load.
      stagedFiles.push([basename, buffer]);
    }
  }
  // ffmpeg output convention: last positional argument (not consumed by a flag).
  const last = expanded[expanded.length - 1];
  const prev = expanded[expanded.length - 2];
  if (last && !last.startsWith('-') && prev !== '-i' && !staged.includes(last)) {
    outputs.push(last);
  }

  const ffmpeg = new AwFfmpeg({ stdout: (l) => console.log(l), stderr: (l) => console.error(l) });
  for (const [name, buffer] of stagedFiles) {
    await ffmpeg.writeFile(name, new Uint8Array(buffer));
  }
  stagedFiles.length = 0;

  const code = await ffmpeg.run(expanded);
  if (code !== 0) return { code };
  for (const out of outputs) {
    const data = await ffmpeg.readFile(out);
    const target = nodePath()!.resolve(process.cwd(), out);
    fs.writeFileSync(target, Buffer.from(data));
    console.error('anywhere: wrote ' + target);
  }
  return { code };
}

const stagedFiles: Array<[string, Buffer]> = [];

// ── python ─────────────────────────────────────────────────────────────────

async function runPythonCmd(args: string[]): Promise<CliResult> {
  if (!args.length || args[0] === '-h' || args[0] === '--help') {
    return { code: 0, output: pythonUsage() };
  }

  let code: string = '';
  const rest = args.slice();
  if (rest[0] === '-c' || rest[0] === '-e') {
    code = rest.slice(1).join(' ');
  } else {
    const file = rest[0];
    const fs = nodeFs()!;
    if (!fs.existsSync(file)) {
      return { code: 1, output: 'anywhere python: no such script "' + file + '"' };
    }
    code = fs.readFileSync(file, 'utf8');
  }

  const python = new AwPython({ source: 'cdn' });
  const cell = await python.runCell(code);
  for (const line of cell.stdout) console.log(line);
  for (const line of cell.stderr) console.error(line);
  if (cell.value !== undefined && cell.value !== null) {
    const shown = typeof cell.value === 'object' ? JSON.stringify(cell.value) : String(cell.value);
    if (shown && shown !== '{}' && shown !== 'null' && shown !== 'undefined') console.log(shown);
  }
  return { code: 0 };
}

// ── llm ────────────────────────────────────────────────────────────────────

async function runLlmCmd(args: string[]): Promise<CliResult> {
  if (!args.length || args[0] === '-h' || args[0] === '--help') {
    return { code: 0, output: llmUsage() };
  }
  if (args[0] === 'list') {
    const rows = Object.values(MODEL_REGISTRY).map(
      (m) => '  ' + (m.id || '').padEnd(18) + (m.sizeMB ? String(m.sizeMB).padStart(6) + 'MB' : '      ') + '  ' + (m.title || '')
    );
    return { code: 0, output: 'Anywhere edge models:\n' + rows.join('\n') };
  }

  const modelId = args[0];
  const flags = parseFlags(args.slice(1));

  if (flags['image']) {
    const fs = nodeFs()!;
    const file = String(flags['image']);
    if (!fs.existsSync(file)) return { code: 1, output: 'anywhere llm: image "' + file + '" not found' };
    const bytes = new Uint8Array(fs.readFileSync(file));
    const pixels = await decodeImageFile(file, bytes);
    if (!pixels) return { code: 1, output: 'anywhere llm: cannot decode "' + file + '" (PNG/JPEG decoders are capability-specific)' };

    const llm = new EdgeLlm();
    const result = await llm.predictImage(modelId, pixels.data, { width: pixels.width, height: pixels.height });
    const lines = (result.top || []).map((t) => '  ' + t.label + '\t' + (t.score * 100).toFixed(2) + '%');
    return { code: 0, output: 'anywhere llm: ' + modelId + ' (' + result.elapsedMs + 'ms)\n' + lines.join('\n') };
  }

  const spec = MODEL_REGISTRY[modelId];
  if (!spec) return { code: 1, output: 'anywhere llm: unknown model "' + modelId + '". `anywhere run llm list`.' };
  return { code: 0, output: spec.title + '\n  kind: ' + (spec.kind || 'custom') + '\n  size: ~' + (spec.sizeMB || '?') + 'MB' };
}

interface DecodedImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/**
 * Decode a PNG into interleaved RGB(A) bytes — pure JS, Node's built-in
 * zlib for the IDAT stream. No canvas, no libpng, no native modules.
 */
async function decodeImageFile(file: string, bytes: Uint8Array): Promise<DecodedImage | null> {
  if (!/\.png$/i.test(file)) {
    console.error('anywhere llm: only PNG inputs are supported for --image (convert with `anywhere run ffmpeg`).');
    return null;
  }
  const zlib = nodeRequire('zlib');

  // PNG signature: 137 80 78 71 13 10 26 10
  if (bytes.length < 8 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
    console.error('anywhere llm: not a PNG file.');
    return null;
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  const pal: number[] = [];

  let off = 8;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (off + 8 <= bytes.length) {
    const len = view.getUint32(off);
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    const data = bytes.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = view.getUint32(off + 8);
      height = view.getUint32(off + 12);
      bitDepth = bytes[off + 16];
      colorType = bytes[off + 17];
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'PLTE') {
      for (let i = 0; i < len; i++) pal.push(data[i]);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len; // length + type + data + crc
  }

  if (bitDepth !== 8) {
    console.error('anywhere llm: only 8-bit PNGs are supported (got bit depth ' + bitDepth + ').');
    return null;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 0 ? 1 : 0;
  if (!channels) {
    console.error('anywhere llm: unsupported PNG color type ' + colorType + '.');
    return null;
  }

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  // interlacing (Adam7) is not supported — exporters rarely use it for photos.
  const out = Buffer.alloc(stride * height * (channels === 1 && pal.length ? 3 : (channels === 4 ? 4 : channels)));
  const bpp = channels;
  const outBpp = out.length / (width * height);

  let prevRow: Buffer | null = null;
  let s = 0;
  while (raw[s] !== undefined) {
    const filter = raw[s];
    const row = Buffer.from(raw.subarray(s + 1, s + 1 + stride));
    s += 1 + stride;
    const un = unfilterRow(filter, row, prevRow, bpp);
    prevRow = un;
    const y = Math.floor((s - 1) / (1 + stride)) - 1;
    for (let x = 0; x < width; x++) {
      if (channels === 1 && pal.length) {
        const idx = un[x] * 3;
        out[(y * width + x) * 3] = pal[idx];
        out[(y * width + x) * 3 + 1] = pal[idx + 1];
        out[(y * width + x) * 3 + 2] = pal[idx + 2];
      } else {
        for (let c =  0; c < outBpp; c++) out[(y * width + x) * outBpp + c] = un[x * outBpp + c];
      }
    }
  }

  return { width, height, data: new Uint8Array(out) };
}

/** Reverse a PNG scanline filter (types 0–4). */
function unfilterRow(filter: number, row: Buffer, prev: Buffer | null, bpp: number): Buffer {
  const out = Buffer.from(row);
  const left = (i: number) => (i < bpp ? 0 : out[i - bpp]);
  const up = (i: number) => (prev ? prev[i] : 0);
  const upLeft = (i: number) => (prev && i >= bpp ? prev[i - bpp] : 0);
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
  };
  switch (filter) {
    case 0:
      break;
    case 1:
      for (let i = 0; i < row.length; i++) out[i] = (out[i] + left(i)) & 0xff;
      break;
    case 2:
      for (let i = 0; i < row.length; i++) out[i] = (out[i] + up(i)) & 0xff;
      break;
    case 3:
      for (let i = 0; i < row.length; i++) out[i] = (out[i] + (((left(i) + up(i)) / 2) | 0)) & 0xff;
      break;
    case 4:
      for (let i = 0; i < row.length; i++) out[i] = (out[i] + paeth(left(i), up(i), upLeft(i))) & 0xff;
      break;
    default:
      throw new Error('anywhere llm: bad PNG filter ' + filter);
  }
  return out;
}

// ── plumbing ────────────────────────────────────────────────────────────────

function parseFlags(args: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
      } else if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        out[a.slice(2)] = args[++i];
      } else {
        out[a.slice(2)] = true;
      }
    }
  }
  return out;
}

function usage(): string {
  return [
    'anywhere ' + CLI_VERSION + ' — WASM runs everywhere.',
    '',
    'usage: anywhere <command> [options]',
    '',
    'commands:',
    '  run ffmpeg [args]      transcode/extract/frame with ffmpeg.wasm',
    '  run python [script]    run a Python script through Pyodide (numpy/pandas ready)',
    '  run llm [model]        run a tiny ONNX model on your CPU',
    '',
    'global:',
    '  -v, --version          print version',
    '  -h, --help             this help',
    '',
    'examples:',
    '  anywhere run ffmpeg -i clip.mp4 clip.gif',
    '  anywhere run ffmpeg -i song.wav song.mp3',
    '  anywhere run python -c "import numpy as np; print(np.arange(5))"',
    '  anywhere run llm list',
  ].join('\n');
}

function ffmpegUsage(): string {
  return [
    'anywhere run ffmpeg [args] — passes args to the wasm ffmpeg build.',
    '',
    'Local files named in args are uploaded into the virtual FS automatically;',
    'the last positional argument is downloaded back as an output file.',
    '',
    'examples:',
    '  anywhere run ffmpeg -i input.mp4 output.mkv',
    '  anywhere run ffmpeg -i input.mp4 -vn -acodec libmp3lame output.mp3',
    '  anywhere run ffmpeg -ss 00:00:01 -i input.mp4 -frames:v 1 frame.png',
  ].join('\n');
}

function pythonUsage(): string {
  return [
    'anywhere run python [script | -c code] — Pyodide CPython in WASM.',
    '',
    'numpy and pandas load automatically when imported.',
    '',
    'examples:',
    '  anywhere run python ./clean.py',
    '  anywhere run python -c "import pandas as pd; print(pd.__version__)"',
  ].join('\n');
}

function llmUsage(): string {
  return [
    'anywhere run llm <model|--image f> — tiny ONNX inference on CPU.',
    '',
    'models:',
    '  list                      show the registry',
    '  <id> --image photo.png    run a vision model on an image',
    '',
    'examples:',
    '  anywhere run llm list',
    '  anywhere run llm mnist-digits --image digit.png',
  ].join('\n');
}
