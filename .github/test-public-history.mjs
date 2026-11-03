import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const checker=fileURLToPath(new URL('./check-public-data.mjs',import.meta.url));
const root=mkdtempSync(join(tmpdir(),'public-history-'));
const env={...process.env};
for(const key of ['GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_AUTHOR_NAME','GIT_AUTHOR_EMAIL','GIT_COMMITTER_NAME','GIT_COMMITTER_EMAIL'])delete env[key];
const run=(...args)=>execFileSync('git',args,{cwd:root,env,stdio:'pipe'}).toString().trim();
const commit=(message)=>{run('add','.');run('commit','--allow-empty','-m',message);return run('rev-parse','HEAD');};
const expectCheck=(args,kinds,label)=>{
 const result=spawnSync(process.execPath,[checker,...args],{cwd:root,env,encoding:'utf8'});
 assert.ifError(result.error);
 assert.equal(result.status,kinds.length?1:0,label);
 const report=JSON.parse(result.stdout);
 assert.deepEqual([...new Set(report.issues.map(issue=>issue.kind))].sort(),[...kinds].sort(),label);
 return report;
};
// This is the exact CLI argument shape used by .githooks/pre-push: immutable
// local_sha from stdin, not a moving branch name. All repositories here are
// local synthetic scratch repositories; no fetch or original history mutation.
const expectHistory=(sha,kinds,label)=>expectCheck(['--history',sha],kinds,label);
try {
 run('init');run('config','user.name','Synthetic');run('config','user.email','synthetic@example.test');
 run('config','commit.gpgsign','false');run('config','core.hooksPath',join(root,'no-hooks'));
 // Fabricated independently of any existing application fixture; never logged.
 const mobile='07'+[6,2,8,4,0,5,1,9].join('');
 const oldBlob=`const sample='${mobile}';\n`;
 writeFileSync(join(root,'test-published.mjs'),oldBlob);
 const baseline=commit('Publish sanitized public source baseline');
 expectHistory(baseline,['non-noreply-author','possible-personal-contact'],'without origin refs all blobs and authors are new');
 run('update-ref','refs/remotes/origin/main',baseline);
 expectHistory(baseline,[],'published suspect blob at origin/main passes new heuristic');
 expectCheck([],['possible-personal-contact'],'working tree stays strict for published blobs');
 expectCheck(['--staged'],['possible-personal-contact'],'index stays strict for published blobs');

 const privateAuthor=commit('Unpublished synthetic author');
 expectHistory(privateAuthor,['non-noreply-author'],'new non-noreply metadata is still rejected');
 run('config','user.email','synthetic@users.noreply.github.com');
 // Each scenario branches from an immutable synthetic commit. No original
 // historical blobs or commit history are changed, even in this scratch repo.
 run('checkout','-b','compliant',baseline);
 writeFileSync(join(root,'test-published.mjs'),"const sample='synthetic';\n");
 const clean=commit('Synthetic compliant update');
 expectHistory(clean,[],'new non-suspect blob passes despite old published suspect blob');

 writeFileSync(join(root,'test-unpublished.mjs'),`const sample='0040 ${mobile.slice(1).match(/.{3}/g).join(' ')}';\n`);
 const suspect=commit('Synthetic suspect boundary counterexample');
 const report=expectHistory(suspect,['possible-personal-contact'],'new unpublished suspect blob fails pre-push history check');
 assert.ok(!JSON.stringify(report).includes(mobile),'history diagnostics omit matched values');
 writeFileSync(join(root,'test-unpublished.mjs'),"const sample='synthetic';\n");
 const repaired=commit('Synthetic later repair');
 expectHistory(repaired,['possible-personal-contact'],'removed suspect content in unpublished ancestry still fails');
 run('checkout','-b','reuse',clean);

 // A published blob reused under a different path is still the same hash.
 writeFileSync(join(root,'test-reused.mjs'),oldBlob);
 const reused=commit('Synthetic published blob reuse');
 expectHistory(reused,[],'publication boundary uses hashes rather than paths');
 run('update-ref','-d','refs/remotes/origin/main');
 expectHistory(reused,['non-noreply-author','possible-personal-contact'],'removing origin refs restores strict whole-history checking');
 run('update-ref','refs/remotes/origin/archive',baseline);
 expectHistory(reused,[],'all origin refs count, not just origin/main');
 run('update-ref','-d','refs/remotes/origin/archive');
 run('update-ref','refs/remotes/other/main',baseline);
 expectHistory(reused,['non-noreply-author','possible-personal-contact'],'other remotes do not grant the origin exception');
 run('update-ref','-d','refs/remotes/other/main');
 run('update-ref','refs/remotes/origin/main',baseline);
 run('checkout','-b','legacy-email',clean);

 const legacyEmail=['synthetic','example.private'].join('@');
 writeFileSync(join(root,'public-note.txt'),legacyEmail);
 const privateEmail=commit('Synthetic legacy email counterexample');
 expectHistory(privateEmail,['non-example-email'],'new private email fails');
 run('update-ref','refs/remotes/origin/main',privateEmail);
 expectHistory(privateEmail,['non-example-email'],'published private email still fails legacy checks');
 writeFileSync(join(root,'public-note.txt'),'synthetic');
 const removedEmail=commit('Synthetic legacy email removal');
 expectHistory(removedEmail,['non-example-email'],'legacy violation in published ancestry still fails after removal');
 run('checkout','-b','legacy-verifier',clean);
 run('update-ref','refs/remotes/origin/main',baseline);

 writeFileSync(join(root,'public-note.txt'),['scrypt','a'.repeat(32),'b'.repeat(64)].join(':'));
 const verifier=commit('Synthetic verifier counterexample');
 run('update-ref','refs/remotes/origin/main',verifier);
 expectHistory(verifier,['password-verifier'],'published legacy verifier still fails');
 console.log('PASS: pre-push history publication boundary, strict worktree/index and legacy privacy checks.');
} finally {rmSync(root,{recursive:true,force:true});}
