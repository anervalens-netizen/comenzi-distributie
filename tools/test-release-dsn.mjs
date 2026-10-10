import assert from 'node:assert/strict';
import {validatePublicDsn} from './release-dsn.mjs';
import {NodeClient} from '@sentry/node';
for(const value of ['https://abc@errors.example.invalid/1','https://abc:legacy@errors.example.invalid/deployed/path/42','http://abc_123@localhost:9000/1']) {
 const url=validatePublicDsn(value);
 const client=new NodeClient({dsn:value,integrations:[],transport:()=>({send:async()=>({}),flush:async()=>true}),stackParser:()=>[]});
 assert.equal(client.getDsn().projectId,url.pathname.split('/').at(-1));
 assert.equal(client.getDsn().publicKey,url.username);
}
for(const value of ['',undefined,'https://abc@?x/1','https://abc@not a host/1','https://@example.invalid/1','ftp://abc@example.invalid/1','https://abc@example.invalid/project','https://abc@example.invalid:0/1','https://abc@example.invalid/1#bad','https://abc@example.invalid/1?bad','https://abc@example.invalid:invalid/1']) assert.throws(()=>validatePublicDsn(value));
console.log('PASS DSN valid deployment/legacy SDK cases and invalid URL/configuration cases');
