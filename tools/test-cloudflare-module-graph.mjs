import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

async function files(root) {
  const result=[];
  for(const entry of await readdir(root,{withFileTypes:true})) {
    const path=join(root,entry.name);
    if(entry.isDirectory())result.push(...await files(path));
    else if(/\.(?:js|mjs|cjs)$/.test(entry.name))result.push(path);
  }
  return result;
}

const forbidden=['node:worker_threads','stock-parser-node'];
const hits=[];
for(const file of await files('dist/server')) {
  const source=await readFile(file,'utf8');
  for(const token of forbidden)if(source.includes(token))hits.push(file+': '+token);
}

assert.deepEqual(hits,[],`Cloudflare server bundle must not include the Node stock worker path:\n${hits.join('\n')}`);
console.log('PASS: Cloudflare server module graph excludes node:worker_threads and stock-parser-node.');
