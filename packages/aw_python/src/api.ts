/**
 * aw_python · api.ts — "data cleaning, everywhere."
 *
 * AwPython is the friendly face over a booted PyodideRuntime: run scripts,
 * auto-load numpy/pandas for imports, and move DataFrames across the JS⇄WASM
 * boundary as plain records. Plus one opinionved helper — `cleanDataset` —
 * that does the four chores every dirty CSV needs.
 */

import { JsonRpcBus, LoopbackTransport, RpcHandler } from '@anywhere/core';
import { PyodideRuntime, PyodideSourceOptions } from './runtime';

export interface RunOptions {
  /** Load numpy/pandas (and any other indexed wheel) for imports in the code. */
  autoPackages?: boolean;
}

export interface DatasetLike {
  columns: string[];
  records: Record<string, any>[];
}

export interface CleanOptions {
  /** Drop rows with any NaN. Default true. */
  dropMissingRows?: boolean;
  /** Fill NaN in numeric columns with this value (0, mean, median…). Default: mean. */
  fillNumeric?: 'mean' | 'median' | number;
  /** Remove exact duplicate rows. Default true. */
  dropDuplicates?: boolean;
  /** Trim whitespace on all string cells. Default true. */
  trimStrings?: boolean;
  /** Column(s) to parse as datetime. */
  parseDates?: string[];
}

export class AwPython {
  public readonly runtime: PyodideRuntime;
  private booted: Promise<void> | null = null;

  constructor(runtimeOrOptions?: PyodideRuntime | PyodideSourceOptions) {
    this.runtime =
      runtimeOrOptions instanceof PyodideRuntime
        ? runtimeOrOptions
        : new LazyRuntime(runtimeOrOptions || {});
  }

  /** Boot the interpreter (idempotent). */
  public ensureBooted(): Promise<void> {
    if (!this.booted) this.booted = this.runtime.run('print()').then(() => undefined);
    return this.booted;
  }

  /** Run Python code; the last expression is returned as a JS value. */
  public async run(code: string, options: RunOptions = {}): Promise<any> {
    await this.ensureBooted();
    if (options.autoPackages !== false) {
      try {
        await this.runtime.loadForScript(code);
      } catch (_e) {
        /* unknown imports are reported by the interpreter itself */
      }
    }
    return this.runtime.run(code);
  }

  /**
   * Run Python code with stdout/stderr captured into JS arrays
   * (the interpreter is tapped via a JS module registered on the runtime).
   */
  public async runCell(code: string, options: RunOptions = {}): Promise<{ value: any; stdout: string[]; stderr: string[] }> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    await this.ensureBooted();
    await this.runtime.registerJsModule('aw_iostream', {
      writeOut: (s: string) => stdout.push(String(s)),
      writeErr: (s: string) => stderr.push(String(s)),
    });
    const tap =
      'import sys\n' +
      'from aw_iostream import writeOut, writeErr\n' +
      'class _AWTap:\n' +
      '    def __init__(s, fn): s.fn = fn\n' +
      '    def write(s, t):\n' +
      '        s.fn(str(t))\n' +
      '    def flush(s): pass\n' +
      'sys.stdout = _AWTap(writeOut)\n' +
      'sys.stderr = _AWTap(writeErr)\n';
    await this.runtime.run(tap);
    const value = await this.run(code, options);
    return { value, stdout, stderr };
  }

  /**
   * Run a script that ends with a DataFrame in `__result__`; get it back as
   * { columns, records }. numpy and pandas are auto-loaded.
   */
  public async runDataFrame(code: string): Promise<DatasetLike> {
    await this.run(ENSURE_PANDAS);
    const wrapped =
      code + '\n\n__c__ = list(__result__.columns)\n__result__.to_dict("records")\n';
    const records = (await this.run(wrapped, { autoPackages: true })) as any[];
    const columns = (await this.runtime.run('__c__')) as string[];
    return { columns, records: toJsRecords(records) };
  }

  /** Turn a JS dataset into a pandas DataFrame inside the interpreter. */
  public async pushDataset(name: string, dataset: DatasetLike): Promise<void> {
    await this.run(ENSURE_PANDAS);
    const payload = JSON.stringify(dataset.records);
    const code =
      'import json, pandas as pd\n' +
      name + ' = pd.DataFrame(json.loads(' + JSON.stringify(payload) + '))\n';
    await this.run(code);
  }

  /** Fetch any variable that is (or converts to) a DataFrame. */
  public async pullDataset(name: string): Promise<DatasetLike> {
    await this.run(ENSURE_PANDAS);
    const code = `__aw_pull__ = ${name}\nif not hasattr(__aw_pull__, "to_dict"):\n    __aw_pull__ = DataFrame(__aw_pull__)\n__result__ = __aw_pull__\n`;
    return this.runDataFrame(code);
  }

  /**
   * The four chores: drop all-NaN rows, fill numeric holes, de-duplicate,
   * trim strings, and optionally parse dates. Returns the cleaned dataset
   * plus a short report of what changed.
   */
  public async cleanDataset(dataset: DatasetLike, options: CleanOptions = {}): Promise<{
    dataset: DatasetLike;
    report: { rowsIn: number; rowsOut: number; duplicatesDropped: number; missingFilled: number; datesParsed: string[] };
  }> {
    const cfg = {
      dropMissingRows: options.dropMissingRows !== false,
      fillNumeric: options.fillNumeric === undefined ? 'mean' : options.fillNumeric,
      dropDuplicates: options.dropDuplicates !== false,
      trimStrings: options.trimStrings !== false,
      parseDates: options.parseDates || [],
    };
    await this.run(ENSURE_PANDAS);
    const value = typeof cfg.fillNumeric === 'number' ? String(cfg.fillNumeric) : '"' + cfg.fillNumeric + '"';
    const pyScript = CLEAN_PY_TEMPLATE
      .replace('__JSON_PAYLOAD__', JSON.stringify(JSON.stringify(dataset.records)))
      .replace('__DROP_MISSING__', String(cfg.dropMissingRows))
      .replace('__FILL_NUMERIC__', value)
      .replace('__DROP_DUPES__', String(cfg.dropDuplicates))
      .replace('__TRIM_STRINGS__', String(cfg.trimStrings))
      .replace('__PARSE_DATES__', JSON.stringify(cfg.parseDates))
      .replace('__JSON_COLUMNS__', JSON.stringify(JSON.stringify(dataset.columns)));
    const report = await this.run(pyScript);
    // The interpreter hands dicts back as JS Maps; read either shape.
    const r: any = report;
    const get = (k: string): any => (r && typeof r.get === 'function' ? r.get(k) : r ? r[k] : undefined);
    const reportObj = {
      rowsIn: get('rowsIn'),
      rowsOut: get('rowsOut'),
      duplicatesDropped: get('duplicatesDropped'),
      missingFilled: get('missingFilled'),
      datesParsed: get('datesParsed'),
    };
    const cleaned = await this.pullDataset('__aw_cleaned__');
    return { dataset: cleaned, report: reportObj };
  }

  /** Register host-side JS functions callable from Python (`js.host.foo`). */
  public exposeHost(host: Record<string, (...args: any[]) => any>): void {
    this.runtime.registerJsModule('host', host);
  }

  public dispose(): void {
    // Pyodide holds no host resources beyond memory; drop our reference.
  }
}

/** Wire an AwPython into an aw_core JSON-RPC bus (in-process loopback). */
export function createPythonRpc(python: AwPython): JsonRpcBus {
  const hostSide = new LoopbackTransport();
  const pySide = new LoopbackTransport();
  LoopbackTransport.pair(hostSide, pySide);

  const pyBus = new JsonRpcBus(pySide, { name: 'aw-python' });
  const handlers: Record<string, RpcHandler> = {
    'py:run': (p: { code?: string }) => python.run(p.code || ''),
    'py:dataframe': (p: { code?: string }) => python.runDataFrame(p.code || ''),
    'py:clean': (p: { dataset?: DatasetLike; options?: CleanOptions }) =>
      python.cleanDataset(p.dataset as DatasetLike, p.options || {}),
    'py:ping': () => ({ ok: true }),
  };
  for (const name of Object.keys(handlers)) pyBus.handle(name, handlers[name]);

  return new JsonRpcBus(hostSide, { name: 'aw-python-host' });
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** Pyodide's toJs returns nested Maps for dicts; normalise to plain records. */
function toJsRecords(value: any): Record<string, any>[] {
  if (!Array.isArray(value)) return value as Record<string, any>[];
  return value.map((row: any) => {
    if (row !== null && typeof row === 'object' && typeof row.get === 'function' && typeof row.keys === 'function') {
      const out: Record<string, any> = {};
      for (const k of Array.from(row.keys() as any[])) out[String(k)] = row.get(k);
      return out;
    }
    return row as Record<string, any>;
  });
}

const ENSURE_PANDAS = 'import pandas as pd\nfrom pandas import DataFrame\n';

const CLEAN_PY_TEMPLATE = `import json, pandas as pd, numpy as np
_records = json.loads(__JSON_PAYLOAD__)
_columns = json.loads(__JSON_COLUMNS__)
df = pd.DataFrame(_records, columns=_columns) if _columns else pd.DataFrame(_records)
_rows_in = len(df)
_dupes = 0
_filled = 0
_dates = []

if __TRIM_STRINGS__:
    for _c in df.columns:
        if df[_c].dtype == object:
            df[_c] = df[_c].map(lambda v: v.strip() if isinstance(v, str) else v)

if __DROP_MISSING__:
    df = df.dropna(how="all").reset_index(drop=True)

for _c in df.columns:
    if df[_c].dtype == object or str(df[_c].dtype) == "object":
        _numeric = pd.to_numeric(df[_c], errors="coerce")
        if _numeric.notna().sum() >= max(1, len(df) // 2):
            df[_c] = _numeric
    if str(df[_c].dtype) in ("float64", "float32", "int64", "int32"):
        _missing = int(df[_c].isna().sum())
        if _missing:
            if isinstance(__FILL_NUMERIC__, str):
                _fill = float(df[_c].mean()) if __FILL_NUMERIC__ == "mean" else float(df[_c].median())
            else:
                _fill = float(__FILL_NUMERIC__)
            df[_c] = df[_c].fillna(_fill)
            _filled += _missing

for _d in __PARSE_DATES__:
    if _d in df.columns:
        df[_d] = pd.to_datetime(df[_d], errors="coerce")
        _dates.append(_d)

if __DROP_DUPES__:
    _dupes = int(df.duplicated().sum())
    df = df.drop_duplicates().reset_index(drop=True)

__aw_cleaned__ = df
__result__ = {
    "rowsIn": int(_rows_in),
    "rowsOut": int(len(df)),
    "duplicatesDropped": _dupes,
    "missingFilled": _filled,
    "datesParsed": _dates,
}
__result__
`;

/** Runtime that builds itself lazily from options. */
class LazyRuntime extends PyodideRuntime {
  private options: PyodideSourceOptions;
  private inner: PyodideRuntime | null = null;
  private pending: Promise<PyodideRuntime> | null = null;

  constructor(options: PyodideSourceOptions) {
    super(null as any, '');
    this.options = options;
  }

  private ensure(): Promise<PyodideRuntime> {
    if (this.inner) return Promise.resolve(this.inner);
    if (!this.pending) this.pending = PyodideRuntime.create(this.options);
    return this.pending.then((rt) => {
      this.inner = rt;
      return rt;
    });
  }

  public run(code: string): Promise<any> {
    return this.ensure().then((rt) => rt.run(code));
  }
  public async loadPackages(names: string | string[]): Promise<void> {
    const rt = await this.ensure();
    await rt.loadPackages(names);
  }
  public async loadForScript(code: string): Promise<void> {
    const rt = await this.ensure();
    await rt.loadForScript(code);
  }
  public async registerJsModule(name: string, mod: any): Promise<void> {
    const rt = await this.ensure();
    rt.registerJsModule(name, mod);
  }
  public async pipInstall(names: string | string[]): Promise<void> {
    const rt = await this.ensure();
    await rt.pipInstall(names);
  }
  public async hasPackage(name: string): Promise<boolean> {
    const rt = await this.ensure();
    return rt.hasPackage(name);
  }
  public banner(): string {
    return this.inner ? this.inner.banner() : 'Anywhere Python (lazy, not booted)';
  }
}
