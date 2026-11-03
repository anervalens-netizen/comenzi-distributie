import {execFileSync} from 'node:child_process';
import {existsSync,readFileSync,lstatSync,readlinkSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const approvedExampleDomains=new Set(['example.com','example.org','example.net','example.invalid','localhost','users.noreply.github.com']);
const syntheticUsers=new Set(['operator','runner','user','test','node','ubuntu','alice','bob','foo']);
const privatePath=/(?:^|\/)(?:\.env(?:\..*)?|devices\.local\.json|credentials(?:\.[^/]*)?|initial-users\.json|seed\.json|templates\.json|template-hashes\.json|mail-defaults\.json|resource-mode\.json)$|\.(?:sqlite(?:3)?|db|pem|key|p12|pfx|jks|keystore|xlsx|xls|csv|apk|aab)$/i;
const privateDirs=/(?:^|\/)(?:\.private|private|\.openai|data|backups|outputs|playwright-report|test-results)(?:\/|$)/;
const sensitivePatterns=[
 ['password-verifier',/scrypt:[a-f0-9]{16,}:[a-f0-9]{32,}|\$2[aby]\$\d{2}\$[A-Za-z0-9./]{53}|\$argon2(?:id|i|d)\$/g],
 ['private-key',/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
 ['access-token',/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-proj-[A-Za-z0-9_-]{30,}|AKIA[A-Z0-9]{16})\b/g],
];
// Match test/fixture directories and filename tokens, not substrings such as
// latest, attestation or contest in ordinary application paths.
const fixturePath=/(?:^|\/)(?:__tests__|__fixtures__|tests?|fixtures?|specs?|test[-_]?data)(?:\/|$)|(?:^|\/)(?:tests?|fixtures?)[._-][^/]+$|[._-](?:test|spec|fixture)\.[^/]+$/i;
const contactField=/\b(?:contact|contactName|contact_name|persoana|person|phone|phoneNumber|phone_number|telefon)\b/i;
function hasContactContext(text,index,length){
 const before=text.slice(0,index),after=text.slice(index+length);
 const start=Math.max(before.lastIndexOf('\n'),before.lastIndexOf('{'),before.lastIndexOf('}'),before.lastIndexOf(';'))+1;
 const boundary=after.search(/[\n{};]/);
 const end=boundary<0?text.length:index+length+boundary;
 if(contactField.test(text.slice(Math.max(start,index-160),Math.min(end,index+length+160))))return true;
 // A small, flat object also supports multiline fixture/contact records without
 // borrowing labels from adjacent objects or unrelated lines. This is a text
 // heuristic, not a parser: nested/large records, computed strings and other
 // phone formats can escape detection; labels near unrelated digits can flag.
 const open=before.lastIndexOf('{'),close=text.indexOf('}',index+length);
 if(open<0||close<0||close-open>400)return false;
 const record=text.slice(open+1,close);
 return !/[{};]/.test(record)&&record.split('\n').length<=6&&contactField.test(record);
}
export function inspectPublicFile(path,text='',{checkPersonalContact=true}={}){
 const issues=[];
 const add=(kind,index=0)=>issues.push({path,kind,line:text.slice(0,index).split('\n').length});
 if((privatePath.test(path)&&!path.endsWith('.env.example'))||privateDirs.test(path))add('private-file-path');
 if(/(?:^|\/)(?:screenshots|design-screenshots)(?:\/|$)/.test(path)||path.startsWith('public/products/'))add('private-or-generated-asset');
 for(const [kind,pattern] of sensitivePatterns){pattern.lastIndex=0;for(const m of text.matchAll(pattern))add(kind,m.index);}
 // QA-only synthetic numbers are exempt in actual test/fixture files: the
 // explicit 07000000xx project sentinel and obvious all-identical/ascending
 // eight-digit suffixes already used in legacy fixtures. This is not proof
 // that a real telecom number cannot share a pattern; do not exempt source.
 const mobile=/(?<![\d+])(?:(?:\+|00)40[ .()-]*|0)7(?:[ .()-]*\d){8}(?!\d)/g;
 if(checkPersonalContact)for(const m of text.matchAll(mobile)){
  const digits=m[0].replace(/\D/g,'').replace(/^(?:0040|40)/,'0');
  const fixture=fixturePath.test(path);
  const suffix=digits.slice(2);
  const syntheticFixture= /^07000000\d{2}$/.test(digits)||/^(\d)\1{7}$/.test(suffix)||'01234567890123456789'.includes(suffix);
  if(fixture&&syntheticFixture)continue;
  if(fixture||hasContactContext(text,m.index,m[0].length))add('possible-personal-contact',m.index);
 }
 if(!/(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|LICENSE[^/]*|NOTICE[^/]*)$/.test(path)){
  for(const m of text.matchAll(/[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/gi)){
   const domain=m[1].toLowerCase();
   if(!approvedExampleDomains.has(domain)&&!['.example.invalid','.example','.test','.invalid','.localhost'].some(suffix=>domain.endsWith(suffix))&&m[0]!=='git@github.com')add('non-example-email',m.index);
  }
 }
 for(const m of text.matchAll(/\/home\/([A-Za-z][A-Za-z0-9_.-]*)/g))if(!syntheticUsers.has(m[1]))add('personal-home-directory',m.index);
 return issues;
}
const git=(args,options={})=>execFileSync('git',args,{maxBuffer:80*1024*1024,...options});
export function checkRepository(args=process.argv.slice(2)){
 const staged=args.includes('--staged');const historyIndex=args.indexOf('--history');
 const files=[];const issues=[];
 if(historyIndex>=0){
  const ref=args[historyIndex+1]||'HEAD';
  if(!/^[A-Za-z0-9_./-]+$/.test(ref)||ref.startsWith('-'))throw new Error('Invalid Git reference.');
  const roots=git(['rev-list','--max-parents=0',ref],{encoding:'utf8'}).trim().split('\n').filter(Boolean);
  if(roots.length!==1||git(['log','-1','--format=%s',roots[0]],{encoding:'utf8'}).trim()!=='Publish sanitized public source baseline')issues.push({path:'<history>',kind:'legacy-history',line:1});
  // Author privacy applies to commits being published. Existing remote merge
  // metadata is immutable history; still inspect every reachable file below.
  // With no remote refs this remains a strict whole-history author check.
  const metadata=git(['log','--format=%ae%n%ce',ref,'--not','--remotes=origin'],{encoding:'utf8'}).trim().split('\n').filter(Boolean);
  if(metadata.some(email=>!email.endsWith('@users.noreply.github.com')))issues.push({path:'<history>',kind:'non-noreply-author',line:1});
  const objects=git(['rev-list','--objects',ref],{encoding:'utf8'}).trim().split('\n').filter(Boolean);
  // Only the newly introduced contact heuristic has a publication boundary.
  // Subtract by object identity, not path or commit age: reused published blobs
  // stay published even when renamed, while edited blobs must be checked.
  // Without origin refs this set is empty, so all historical blobs are new.
  // This depends on local origin refs being current; it is not a remote query.
  const published=new Set(git(['rev-list','--objects','--remotes=origin'],{encoding:'utf8'}).trim().split('\n').filter(Boolean).map(entry=>entry.split(' ',1)[0]));
  const seen=new Set();
  for(const entry of objects){
   const space=entry.indexOf(' ');if(space<0)continue;
   const sha=entry.slice(0,space),path=entry.slice(space+1);if(seen.has(sha))continue;seen.add(sha);
   if(git(['cat-file','-t',sha],{encoding:'utf8'}).trim()!=='blob')continue;
   files.push([path,git(['cat-file','blob',sha]),{checkPersonalContact:!published.has(sha)}]);
  }
 }else{
  const paths=git(['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
  for(const path of paths){
   if(staged){files.push([path,git(['show',`:${path}`])]);continue;}
   if(!existsSync(path))continue;
   if(lstatSync(path).isSymbolicLink()){
    const target=readlinkSync(path);if(target.startsWith('/')||target.split('/').includes('..'))issues.push({path,kind:'external-symlink',line:1});
    continue;
   }
   files.push([path,readFileSync(path)]);
  }
 }
 for(const [path,data,options] of files)issues.push(...inspectPublicFile(path,data.includes(0)?'':data.toString('utf8'),options));
 // Never print matching values, credentials or personal content into CI logs.
 console.log(JSON.stringify({status:issues.length?'FAIL':'PASS',filesScanned:files.length,issues}));
 return issues.length?1:0;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{process.exitCode=checkRepository();}catch(error){console.error('Public-data verification could not complete: '+error.message.split('\n')[0]);process.exitCode=2;}}
