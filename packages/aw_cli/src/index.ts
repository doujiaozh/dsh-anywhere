/**
 * @anywhere/cli — the `anywhere` command. See bin/anywhere.js for the shim.
 */

import { runCli } from './cli';

export { runCli, CLI_VERSION, CliResult } from './cli';
export const AW_CLI_VERSION = '0.1.0';

// When invoked directly (`node bin/anywhere.js`), run the argv we were given.
if (require.main === module) {
  runCli(process.argv)
    .then((r) => {
      if (r.output) console.log(r.output);
      process.exit(r.code);
    })
    .catch((e) => {
      console.error('anywhere:', e && e.message ? e.message : String(e));
      process.exit(1);
    });
}
