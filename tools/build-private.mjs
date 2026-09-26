import {existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,realpathSync,cpSync,rmSync,renameSync,statSync} from 'node:fs';
import {resolve,relative,dirname,join,isAbsolute,sep} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

// A private build is always isolated from the public checkout and never deploys.
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
const option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
const sourceArg=option('--resources'),outputArg=option('--output'),productsArg=option('--products');
if(!sourceArg||!outputArg)throw new Error('Usage: node tools/build-private.mjs --resources /private/resources --output /private/new-release [--products /private/product-images]');
const inside=(parent,path)=>{const rel=relative(parent,path);return rel===''||(!rel.startsWith('..'+sep)&&rel!=='..'&&!isAbsolute(rel));};
const sources=realpathSync(resolve(sourceArg));
const out=resolve(outputArg);
if(existsSync(out))throw new Error('Output already exists; refusing to replace it.');
const parent=realpathSync(dirname(out));
if(inside(root,sources)||inside(root,parent))throw new Error('Private resources and build output must be outside the public repository.');
if(inside(sources,out))throw new Error('Build output must not be inside the resource directory.');
const manifest=JSON.parse(readFileSync(join(sources,'resource-mode.json'),'utf8'));
if(manifest.mode!=='private'||manifest.schema!==1)throw new Error('An explicitly classified private resource set is required.');
const names=['seed.json','initial-users.json','accesorii.xlsx','standuri.xlsx','templates.json','template-hashes.json','mail-defaults.json'];
const hashes={};
for(const name of names){
 const path=realpathSync(join(sources,name));
 if(!inside(sources,path)||!statSync(path).isFile())throw new Error('Resource path escapes the private resource directory.');
 hashes[name]=createHash('sha256').update(readFileSync(path)).digest('hex');
 if(!manifest.sha256||manifest.sha256[name]!==hashes[name])throw new Error(`Missing or mismatched integrity record for ${name}.`);
}
const git=(argv)=>execFileSync('git',argv,{cwd:root,encoding:'utf8',maxBuffer:20*1024*1024});
if(git(['status','--porcelain','--untracked-files=no']).trim())throw new Error('Commit the reviewed source before creating a release.');
const sha=git(['rev-parse','HEAD']).trim();
const stage=mkdtempSync(join(parent,'.private-build-'));
const stagedSource=join(stage,'source');mkdirSync(stagedSource,{mode:0o700});
const tar=join(stage,'source.tar');
let published=false;
try{
 execFileSync('git',['archive','--format=tar','-o',tar,sha],{cwd:root,stdio:'inherit'});
 execFileSync('tar',['-xf',tar,'-C',stagedSource],{stdio:'inherit'});
 const inputs=join(stagedSource,'resources');mkdirSync(inputs,{recursive:true,mode:0o700});
 for(const name of names)cpSync(join(sources,name),join(inputs,name),{errorOnExist:true,force:false});
 writeFileSync(join(inputs,'resource-mode.json'),JSON.stringify(manifest),{mode:0o600});
 if(productsArg){
  const products=realpathSync(resolve(productsArg));
  if(inside(root,products))throw new Error('Product images must come from a private directory outside Git.');
  cpSync(products,join(stagedSource,'public/products'),{recursive:true,errorOnExist:true,force:false,dereference:false});
 }
 const env={...process.env,MOBIUP_RESOURCE_MODE:'private'};
 for(const argv of [['ci','--no-audit','--no-fund'],['run','build:server']]){
  const result=spawnSync('npm',argv,{cwd:stagedSource,env,stdio:'inherit'});
  if(result.error)throw result.error;
  if(result.status!==0)throw new Error(`Private build failed (exit ${result.status}); no deployment performed.`);
 }
 const release=join(stagedSource,'dist/standalone');
 if(!existsSync(join(release,'server.js')))throw new Error('Build did not produce the server entry point.');
 const metadata={sha,builtAt:new Date().toISOString(),resourceMode:'private',resourceSchema:1,resourceDigest:createHash('sha256').update(JSON.stringify(hashes)).digest('hex')};
 writeFileSync(join(release,'RELEASE.json'),JSON.stringify(metadata)+'\n',{mode:0o600});
 if(existsSync(out))throw new Error('Output was created concurrently; refusing to replace it.');
 renameSync(release,out);published=true;
 console.log(JSON.stringify({status:'BUILT_NOT_DEPLOYED',sha,resourceMode:'private',output:out}));
}finally{
 // Only remove the unique temporary directory created by this invocation.
 rmSync(stage,{recursive:true,force:true});
 if(!published)console.error('Private build not published; production remains unchanged.');
}
