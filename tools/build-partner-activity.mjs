import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const directory=process.env.MOBIUP_DATA_DIR;
const args=process.argv.slice(2);
if(args.length&&(args.length!==2||args[0]!=='--output'||!args[1]||args[1].startsWith('--')))throw new Error('Usage: build-partner-activity.mjs [--output /explicit/staging/partner-activity.sqlite]');
if(!directory)throw new Error('Set MOBIUP_DATA_DIR explicitly. No default production path.');
const temp=mkdtempSync(join(tmpdir(),'partner-activity-build-'));
try{
 const path=join(temp,'builder.mjs');
 await build({entryPoints:['lib/partner-activity-snapshot.ts'],outfile:path,bundle:true,platform:'node',format:'esm',logLevel:'silent'});
 const {buildActivitySnapshot}=await import(pathToFileURL(path).href);
 const result=buildActivitySnapshot(resolve(directory),undefined,args[1]);
 console.log(JSON.stringify({state:'ready',rows:result.rows,through:result.through,version:result.version}));
}finally{rmSync(temp,{recursive:true,force:true});}
