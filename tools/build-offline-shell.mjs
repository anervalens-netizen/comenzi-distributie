import {build} from 'esbuild';
import {readdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
export async function buildOfflineShell(){
 const root=resolve('dist/client');
 const result=await build({entryPoints:['lib/offline-entry.tsx'],outdir:join(root,'_next/static/offline'),entryNames:'app-[hash]',chunkNames:'chunk-[hash]',assetNames:'asset-[hash]',bundle:true,splitting:true,format:'esm',platform:'browser',minify:true,metafile:true,jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},alias:{'@':resolve('.'),'next/image':resolve('tools/offline-image.tsx')},loader:{'.woff2':'file','.png':'file','.webp':'file'},plugins:[{name:'vite-worker',setup(b){b.onResolve({filter:/\?worker&url$/},args=>({path:args.path,namespace:'offline-worker'}));b.onLoad({filter:/.*/,namespace:'offline-worker'},async()=>{const files=await readdir(join(root,'_next/static/workers'));const worker=files.find(f=>f.startsWith('maplibre-gl-worker-'));return {contents:`export default ${JSON.stringify('/_next/static/workers/'+worker)}`,loader:'js'};});}}]});
 const outputs=new Map(Object.entries(result.metafile.outputs).map(([path,metadata])=>[resolve(path),metadata]));
 const entry=[...outputs].find(([path,metadata])=>path.endsWith('.js')&&metadata.entryPoint&&resolve(metadata.entryPoint)===resolve('lib/offline-entry.tsx'));
 if(!entry)throw new Error('Offline entry missing');
 const resolveOutput=(from,reference)=>{
  const projectRelative=resolve(reference);
  if(outputs.has(projectRelative))return projectRelative;
  const outputRelative=resolve(dirname(from),reference);
  return outputs.has(outputRelative)?outputRelative:null;
 };
 const criticalOutputs=new Set();
 const visit=path=>{
  if(criticalOutputs.has(path))return;
  const metadata=outputs.get(path);
  if(!metadata)return;
  criticalOutputs.add(path);
  if(metadata.cssBundle){
   const css=resolveOutput(path,metadata.cssBundle);
   if(css)visit(css);
  }
  for(const dependency of metadata.imports){
   if(dependency.external||dependency.kind==='dynamic-import')continue;
   const imported=resolveOutput(path,dependency.path);
   if(imported)visit(imported);
  }
 };
 visit(entry[0]);
 const toPublicPath=path=>{
  if(path!==root&&!path.startsWith(root+'/'))throw new Error(`Shell output is outside dist/client: ${path}`);
  return '/'+path.slice(root.length+1).replaceAll('\\','/');
 };
 const criticalStatic=[...criticalOutputs].map(toPublicPath);
 const files=[];async function scan(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const p=join(dir,entry.name);if(entry.isDirectory())await scan(p);else files.push('/'+p.slice(root.length+1));}}await scan(join(root,'_next/static'));
 const scripts=criticalStatic.filter(f=>/^\/_next\/static\/offline\/app-.*\.js$/.test(f));if(scripts.length!==1)throw new Error('Offline entry missing');
 const css=criticalStatic.filter(f=>f.endsWith('.css'));const html=`<!doctype html><html lang="ro"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="manifest" href="/manifest.webmanifest"><title>Mobiup · Date locale</title>${css.map(f=>`<link rel="stylesheet" href="${f}">`).join('')}<body><div id="offline-app"></div><script type="module" src="${scripts[0]}"></script></body></html>`;
 await writeFile(join(root,'offline.html'),html);
 const essential=[...new Set(['/offline.html','/manifest.webmanifest','/icons/icon-192.png','/mobiup-logo.webp',...criticalStatic])].sort((a,b)=>a.localeCompare(b));
 const essentialSet=new Set(essential);
 const optional=[...new Set(['/icons/icon-512.png','/icons/maskable-512.png',...files].filter(path=>!essentialSet.has(path)))].sort((a,b)=>a.localeCompare(b));
 if([...essential,...optional].some(path=>path.startsWith('/api/')||path.startsWith('/api?')))throw new Error('Private API paths cannot be part of the offline shell');
 const version=createHash('sha256').update(html+essential.join('\n')+'\n--optional--\n'+optional.join('\n')).digest('hex').slice(0,16);
 let sw=await readFile('public/sw.js','utf8');
 if(!sw.includes('/*__SHELL_ESSENTIAL__*/[]')||!sw.includes('/*__SHELL_OPTIONAL__*/[]'))throw new Error('Service worker shell placeholders missing');
 sw=sw.replace('__SHELL_VERSION__',version).replace('/*__SHELL_ESSENTIAL__*/[]',JSON.stringify(essential)).replace('/*__SHELL_OPTIONAL__*/[]',JSON.stringify(optional));
 await writeFile(join(root,'sw.js'),sw);
}
