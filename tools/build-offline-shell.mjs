import {build} from 'esbuild';
import {readdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
export async function buildOfflineShell(){
 const root=resolve('dist/client');
 await build({entryPoints:['lib/offline-entry.tsx'],outdir:join(root,'offline-assets'),entryNames:'app-[hash]',chunkNames:'chunk-[hash]',assetNames:'asset-[hash]',bundle:true,splitting:true,format:'esm',platform:'browser',minify:true,jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},alias:{'@':resolve('.'),'next/image':resolve('tools/offline-image.tsx')},loader:{'.woff2':'file','.png':'file'},plugins:[{name:'vite-worker',setup(b){b.onResolve({filter:/\?worker&url$/},args=>({path:args.path,namespace:'offline-worker'}));b.onLoad({filter:/.*/,namespace:'offline-worker'},async()=>{const files=await readdir(join(root,'_next/static/workers'));const worker=files.find(f=>f.startsWith('maplibre-gl-worker-'));return {contents:`export default ${JSON.stringify('/_next/static/workers/'+worker)}`,loader:'js'};});}}]});
 const files=[];async function scan(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const p=join(dir,entry.name);if(entry.isDirectory())await scan(p);else files.push('/'+p.slice(root.length+1));}}await scan(join(root,'offline-assets'));await scan(join(root,'_next/static'));
 const scripts=files.filter(f=>/^\/offline-assets\/app-.*\.js$/.test(f));if(scripts.length!==1)throw new Error('Offline entry missing');
 const css=files.filter(f=>f.endsWith('.css'));const html=`<!doctype html><html lang="ro"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="manifest" href="/manifest.webmanifest"><title>Mobiup · Date locale</title>${css.map(f=>`<link rel="stylesheet" href="${f}">`).join('')}<body><div id="offline-app"></div><script type="module" src="${scripts[0]}"></script></body></html>`;
 await writeFile(join(root,'offline-app.html'),html);
 const assets=[...new Set(['/offline-app.html','/offline.html','/manifest.webmanifest','/icons/icon-192.png','/icons/icon-512.png','/icons/maskable-512.png','/mobiup-logo.png',...files])].sort((a,b)=>a.localeCompare(b));
 const version=createHash('sha256').update(html+assets.join('\n')).digest('hex').slice(0,16);
 let sw=await readFile('public/sw.js','utf8');sw=sw.replace('__SHELL_VERSION__',version).replace('/*__SHELL_ASSETS__*/[]',JSON.stringify(assets));await writeFile(join(root,'sw.js'),sw);
}
