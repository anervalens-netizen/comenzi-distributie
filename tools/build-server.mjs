import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
const result = spawnSync(process.execPath, ['node_modules/vinext/dist/cli.js', 'build'], {
  stdio: 'inherit', env: { ...process.env, MOBIUP_RUNTIME: 'node' },
});
if(result.error)throw result.error;
if(result.status!==0)process.exit(result.status??1);
await build({entryPoints:['lib/sales-parser-worker.ts'],outfile:'dist/standalone/sales-parser-worker.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
await build({entryPoints:['lib/sales-view-worker.ts'],outfile:'dist/standalone/sales-view-worker.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
await build({entryPoints:['lib/stock-parser-worker.ts'],outfile:'dist/standalone/stock-parser-worker.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
