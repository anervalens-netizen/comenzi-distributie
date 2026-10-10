import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

// Append-only identity metadata preserves every original generated coordinate.
// The SDK obtains the ID from the release manifest, not a global stack registry.
export function addBackendDebugIdentity(scriptPath,mapPath,relative,release) {
 if (!/^[a-f0-9]{40}$/.test(release)) throw new Error('Invalid backend release');
 const script=fs.readFileSync(scriptPath), map=JSON.parse(fs.readFileSync(mapPath,'utf8'));
 if (map.version!==3 || !Array.isArray(map.sources) || typeof map.mappings!=='string')
  throw new Error('Invalid backend source map');
 if (map.debug_id || map.debugId || script.includes(Buffer.from('//# debugId=')))
  throw new Error('Backend artifact already has an identity');
 // UUIDv5, scoped to the source release, relative path and exact original bytes.
 const namespace=Buffer.from('6ba7b8119dad11d180b400c04fd430c8','hex');
 const bytes=crypto.createHash('sha1').update(namespace)
  .update(release+'\0'+relative+'\0'+sha(script)+'\0'+sha(JSON.stringify(map))).digest().subarray(0,16);
 bytes[6]=(bytes[6]&15)|80;bytes[8]=(bytes[8]&63)|128;
 const hex=bytes.toString('hex');
 const debugId=[hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
 fs.appendFileSync(scriptPath,'\n//# debugId='+debugId+'\n');
 map.debug_id=debugId;
 fs.writeFileSync(mapPath,JSON.stringify(map));
 return debugId;
}

export function exportBackendMaps(root,release) {
 const backend=path.join(root,'.private-source-maps/backend');
 const workers=path.join(root,'.private-source-maps/workers');
 for(const target of [backend,workers]) {
  if(fs.existsSync(target))throw new Error('Backend map output already exists');
  fs.mkdirSync(target,{recursive:true,mode:0o700});
 }
 const workerNames=new Set(['sales-parser-worker.mjs','sales-view-worker.mjs','stock-parser-worker.mjs','client-history-import-worker.mjs']);
 const backendFiles={},workerFiles={};
 for(const map of fs.globSync('**/*.{js,mjs}.map',{cwd:root,exclude:['node_modules/**','public/**','dist/client/**','.private-source-maps/**']})) {
  const relative=map.slice(0,-4), worker=workerNames.has(relative);
  if(!worker&&!relative.startsWith('dist/server/'))throw new Error('Unclassified backend map');
  const debugId=worker?undefined:addBackendDebugIdentity(path.join(root,relative),path.join(root,map),relative,release);
  const target=path.join(worker?workers:backend,relative);
  fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
  fs.copyFileSync(path.join(root,relative),target);
  fs.renameSync(path.join(root,map),target+'.map');
  const entry={js:sha(fs.readFileSync(target)),map:sha(fs.readFileSync(target+'.map'))};
  if(debugId)entry.debug_id=debugId;
  (worker?workerFiles:backendFiles)[relative]=entry;
 }
 if(Object.keys(workerFiles).length!==4||Object.keys(backendFiles).length===0)
  throw new Error('Missing backend maps or application workers');
 for(const [target,files] of [[backend,backendFiles],[workers,workerFiles]])
  fs.writeFileSync(path.join(target,'manifest.json'),JSON.stringify({release,files})+'\n',{mode:0o600});
 return {backend:backendFiles,workers:workerFiles};
}
