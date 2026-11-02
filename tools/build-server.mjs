import {copyFileSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
const result = spawnSync(process.execPath, ['node_modules/vinext/dist/cli.js', 'build'], {
  stdio: 'inherit', env: { ...process.env, MOBIUP_RUNTIME: 'node' },
});
if(result.error)throw result.error;
if(result.status!==0)process.exit(result.status??1);
copyFileSync('deploy/server.mjs','dist/standalone/server.js');
copyFileSync('deploy/bind-ready.mjs','dist/standalone/bind-ready.mjs');
copyFileSync('deploy/error-reporting.mjs','dist/standalone/error-reporting.mjs');
copyFileSync('deploy/backend-frame-identity.mjs','dist/standalone/backend-frame-identity.mjs');
copyFileSync('deploy/sim_tooling.py','dist/standalone/sim_tooling.py');
await build({entryPoints:['lib/sales-parser-worker.ts'],outfile:'dist/standalone/sales-parser-worker.mjs',bundle:true,platform:'node',format:'esm',packages:'external',sourcemap:'external'});
await build({entryPoints:['lib/sales-view-worker.ts'],outfile:'dist/standalone/sales-view-worker.mjs',bundle:true,platform:'node',format:'esm',packages:'external',sourcemap:'external'});
await build({entryPoints:['lib/stock-parser-worker.ts'],outfile:'dist/standalone/stock-parser-worker.mjs',bundle:true,platform:'node',format:'esm',packages:'external',sourcemap:'external'});

await build({entryPoints:['lib/import-engine-sales.ts'],outfile:'dist/standalone/import-engine-sales.mjs',bundle:true,platform:'node',format:'esm',packages:'external',sourcemap:'external',alias:{'#mobiup-runtime':'./lib/runtime-node.ts','#mobiup-sales-parser':'./lib/sales-parser-node.ts','#mobiup-sales-view':'./lib/sales-view-node.ts','#mobiup-stock-parser':'./lib/stock-parser-node.ts'},plugins:[{name:'raw-sql',setup(plugin){plugin.onResolve({filter:/^@\/drizzle\/.*\.sql\?raw$/},args=>({path:resolve(args.path.slice(2,-4)),namespace:'raw-sql'}));plugin.onLoad({filter:/.*/,namespace:'raw-sql'},args=>({contents:readFileSync(args.path,'utf8'),loader:'text'}));}}]});
await build({entryPoints:['lib/import-engine-refresh.ts'],outfile:'dist/standalone/import-engine-refresh.mjs',bundle:true,platform:'node',format:'esm',packages:'external',sourcemap:'external'});
await build({entryPoints:['lib/client-history-import-worker.ts'],outfile:'dist/standalone/client-history-import-worker.mjs',bundle:true,platform:'node',format:'esm',packages:'external',sourcemap:'external'});
for(const name of ['client_sales_history.py','client_history_upload.py','client_catalog_plan.py','activation_versions.py','activation_projection.py','activations.py','activation_report.py','activation_job.py','distribution_configure.py','import_engine_history.py','import_engine_sim.py','import-engine-executor.mjs'])copyFileSync('tools/'+name,'dist/standalone/'+name);

// Workers must be emitted before tracing so their dependencies are included.
const {packageRuntime} = await import('./package-runtime.mjs');
await packageRuntime('dist/standalone');

// Export the exact browser maps only after runtime dependency tracing. Private
// copies must not accidentally become additional dependency trace entrypoints.
const {exportPrivateMaps} = await import('./private-source-maps.mjs');
const {execFileSync} = await import('node:child_process');

const sourceRelease = process.env.GLITCHTIP_RELEASE || execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
exportPrivateMaps('dist/standalone/dist/client','dist/standalone/.private-source-maps/client',sourceRelease);
const {exportBackendMaps}=await import('./private-backend-source-maps.mjs');
exportBackendMaps('dist/standalone',sourceRelease);
