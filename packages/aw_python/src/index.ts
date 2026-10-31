/**
 * @anywhere/python — "data cleaning, everywhere": Pyodide edge runtime.
 */

export {
  AwPython,
  CleanOptions,
  DatasetLike,
  RunOptions,
  createPythonRpc,
} from './api';

export {
  PYODIDE_CDN_INDEX,
  PYODIDE_VERSION,
  PyodideInterface,
  PyodideRuntime,
  PyodideSourceOptions,
} from './runtime';

export const AW_PYTHON_VERSION = '0.1.0';
