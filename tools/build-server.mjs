import {copyFileSync} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
const result = spawnSync(process.execPath, ['node_modules/vinext/dist/cli.js', 'build'], {
  stdio: 'inherit', env: { ...process.env, MOBIUP_RUNTIME: 'node' },
});
if(result.error)throw result.error;
if(result.status!==0)process.exit(result.status??1);
copyFileSync('deploy/server.mjs','dist/standalone/server.js');
copyFileSync('deploy/bind-ready.mjs','dist/standalone/bind-ready.mjs');
await build({entryPoints:['lib/sales-parser-worker.ts'],outfile:'dist/standalone/sales-parser-worker.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
await build({entryPoints:['lib/sales-view-worker.ts'],outfile:'dist/standalone/sales-view-worker.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
await build({entryPoints:['lib/stock-parser-worker.ts'],outfile:'dist/standalone/stock-parser-worker.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});

await build({entryPoints:['lib/client-history-import-worker.ts'],outfile:'dist/standalone/client-history-import-worker.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
for(const name of ['client_sales_history.py','client_history_upload.py'])copyFileSync('tools/'+name,'dist/standalone/'+name);
