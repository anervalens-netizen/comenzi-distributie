import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const checker=resolve('.github/check-public-data.mjs'),root=mkdtempSync(join(tmpdir(),'public-history-'));
const run=(...args)=>execFileSync('git',args,{cwd:root,stdio:'pipe'}).toString().trim();
const check=()=>spawnSync(process.execPath,[checker,'--history','HEAD'],{cwd:root,encoding:'utf8'});
try {
 run('init');run('config','user.name','Synthetic');run('config','user.email','synthetic@example.test');
 writeFileSync(join(root,'fixture.txt'),'synthetic source');run('add','.');run('commit','-m','Publish sanitized public source baseline');
 assert.equal(check().status,1,'unpublished non-noreply metadata is rejected');
 run('update-ref','refs/remotes/origin/main',run('rev-parse','HEAD'));
 assert.equal(check().status,0,'existing published metadata does not block compliant new work');
 run('commit','--allow-empty','-m','Unpublished private author');assert.equal(check().status,1);
 run('config','user.email','synthetic@users.noreply.github.com');run('commit','--amend','--allow-empty','--reset-author','--no-edit');assert.equal(check().status,0);
 writeFileSync(join(root,'private.txt'),['owner','example.private'].join('@'));run('add','.');run('commit','-m','Synthetic boundary counterexample');assert.equal(check().status,1,'full file privacy scan remains strict');
 console.log('PASS: published history, new-author boundary and full file privacy checks.');
} finally {rmSync(root,{recursive:true,force:true});}
