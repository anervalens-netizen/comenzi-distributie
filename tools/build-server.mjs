import {dirname,join} from 'node:path';
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
copyFileSync('deploy/error-reporting.mjs','dist/standalone/error-reporting.mjs');
await build({entryPoints:['lib/sales-parser-worker.ts'],outfile:'dist/standalone/sales-parser-worker.mjs',bundle:true,platform:'node',format:'esm',packages:'external',sourcemap:'external'});
await build({entryPoints:['lib/sales-view-worker.ts'],outfile:'dist/standalone/sales-view-worker.mjs',bundle:true,platform:'node',format:'esm',packages:'external',sourcemap:'external'});
await build({entryPoints:['lib/stock-parser-worker.ts'],outfile:'dist/standalone/stock-parser-worker.mjs',bundle:true,platform:'node',format:'esm',packages:'external',sourcemap:'external'});

await build({entryPoints:['lib/client-history-import-worker.ts'],outfile:'dist/standalone/client-history-import-worker.mjs',bundle:true,platform:'node',format:'esm',packages:'external',sourcemap:'external'});
for(const name of ['client_sales_history.py','client_history_upload.py'])copyFileSync('tools/'+name,'dist/standalone/'+name);

// Workers must be emitted before tracing so their dependencies are included.
const {packageRuntime} = await import('./package-runtime.mjs');
await packageRuntime('dist/standalone');

// Export the exact browser maps only after runtime dependency tracing. Private
// copies must not accidentally become additional dependency trace entrypoints.
const {exportPrivateMaps} = await import('./private-source-maps.mjs');
const {execFileSync} = await import('node:child_process');
const {globSync,mkdirSync,cpSync,renameSync,writeFileSync,readFileSync} = await import('node:fs');

const {createHash} = await import('node:crypto');
const sourceRelease = process.env.GLITCHTIP_RELEASE || execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
exportPrivateMaps('dist/standalone/dist/client','dist/standalone/.private-source-maps/client',sourceRelease);
const backendRoot='dist/standalone';
const backendPrivate=join(backendRoot,'.private-source-maps/backend');
const backendFiles={};
for(const map of globSync('**/*.{js,mjs}.map',{cwd:backendRoot,exclude:['node_modules/**','public/**','dist/client/**','.private-source-maps/**']})) {
 const script=map.slice(0,-4);const target=join(backendPrivate,script);mkdirSync(dirname(target),{recursive:true,mode:0o700});
 cpSync(join(backendRoot,script),target);renameSync(join(backendRoot,map),target+'.map');
 backendFiles[script]={js:createHash('sha256').update(readFileSync(target)).digest('hex'),map:createHash('sha256').update(readFileSync(target+'.map')).digest('hex')};
}
mkdirSync(backendPrivate,{recursive:true,mode:0o700});
writeFileSync(join(backendPrivate,'manifest.json'),JSON.stringify({release:sourceRelease,files:backendFiles})+'\n',{mode:0o600});

// Worker names are unique and their esbuild maps are independent of the
// framework's duplicate index.js and upstream RSC map limitations.
const workersPrivate=join(backendRoot,'.private-source-maps/workers');
mkdirSync(workersPrivate,{recursive:true,mode:0o700});
const workerFiles={};
for(const [name,hashes] of Object.entries(backendFiles)) {
 if(!name.endsWith('-worker.mjs')||name.includes('/'))continue;
 cpSync(join(backendPrivate,name),join(workersPrivate,name));
 cpSync(join(backendPrivate,name+'.map'),join(workersPrivate,name+'.map'));
 workerFiles[name]=hashes;
}
if(Object.keys(workerFiles).length!==4)throw new Error('Expected four mapped application workers');
writeFileSync(join(workersPrivate,'manifest.json'),JSON.stringify({release:sourceRelease,files:workerFiles})+'\n',{mode:0o600});
