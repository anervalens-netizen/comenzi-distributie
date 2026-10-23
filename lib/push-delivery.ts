import { createVapidJwt, urlBase64ToUint8Array } from '@mmmike/web-push/vapid';
import { WebPushError, type PushPayload, type PushSubscriptionData, type SendPushBatchResult, type VapidConfig } from '@mmmike/web-push/send';

/* RFC 8291 encryption core adapted from @mmmike/web-push 1.3.0, src/encrypt.ts:
 * https://github.com/MMMikeM/web-push
 * MIT License, Copyright (c) 2024 Mike
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
export const PUSH_ENDPOINT_MAX=4096;
const encoder=new TextEncoder();
type Bytes=Uint8Array<ArrayBuffer>;

/** Dedicated browser push services only. Never accept a caller-controlled DNS name.
 * Chromium: components/push_messaging/push_messaging_constants.cc (/fcm/send/ and /wp/).
 * Mozilla: https://autopush.readthedocs.io/en/stable/ (production endpoint).
 * Apple: https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers
 * WNS: https://learn.microsoft.com/en-us/windows/apps/develop/notifications/push-notifications/wns-overview
 * WNS assigns regional hosts in its dedicated namespace; allow one DNS label only.
 * DNS and TLS for these services remain trusted; no user-owned domains or IPs qualify.
 */
export function isAllowedPushEndpoint(endpoint:string):boolean{
  if(!endpoint||endpoint.length>PUSH_ENDPOINT_MAX||!/^[\x21-\x7e]+$/.test(endpoint)||endpoint.includes('#'))return false;
  let url:URL;try{url=new URL(endpoint);}catch{return false;}
  // Browser serialization is canonical. Reject credentials, explicit ports (even :443),
  // escaped/trailing-dot hostnames, backslashes, whitespace and normalization tricks.
  if(url.protocol!=='https:'||url.username||url.password||url.port||url.href!==endpoint)return false;
  if(url.hostname==='fcm.googleapis.com')return !url.search&&/^\/(?:fcm\/send|wp)\/[A-Za-z0-9_:=-]+$/.test(url.pathname);
  if(url.hostname==='updates.push.services.mozilla.com')return !url.search&&/^\/wpush\/v[12]\/[A-Za-z0-9_=-]+$/.test(url.pathname);
  if(url.hostname==='web.push.apple.com')return !url.search&&/^\/[A-Za-z0-9_-]+$/.test(url.pathname);
  if(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.notify\.windows\.com$/.test(url.hostname)){
    return url.pathname==='/w/'&&[...url.searchParams.keys()].length===1&&!!url.searchParams.get('token');
  }
  return false;
}

function concat(...parts:Bytes[]):Bytes{
  const result=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));
  let offset=0;for(const part of parts){result.set(part,offset);offset+=part.length;}return result;
}
const info=(label:string,...context:Bytes[])=>concat(encoder.encode(label+'\0'),...context);
async function hkdf(ikm:Bytes,salt:Bytes,context:Bytes,length:number):Promise<Bytes>{
  const key=await crypto.subtle.importKey('raw',ikm,'HKDF',false,['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt,info:context},key,length));
}

/** RFC 8291 sections 3.1–3.4 and RFC 8188 section 2.1, single aes128gcm record.
 * Explicit ephemeral inputs make the RFC's known-answer vector testable. The sender
 * below always generates a fresh key pair and salt for each message.
 * https://www.rfc-editor.org/rfc/rfc8291#section-3
 */
export async function encryptPushRecord(payload:Bytes,keys:PushSubscriptionData['keys'],ephemeral:CryptoKeyPair,salt:Bytes):Promise<Bytes>{
  if(payload.length>3993||salt.length!==16)throw new Error('Invalid push record size.');
  if(!/^[A-Za-z0-9_-]{87}$/.test(keys.p256dh)||!/^[A-Za-z0-9_-]{22}$/.test(keys.auth))throw new Error('Invalid push keys.');
  const receiver=urlBase64ToUint8Array(keys.p256dh),auth=urlBase64ToUint8Array(keys.auth);
  if(receiver.length!==65||receiver[0]!==4||auth.length!==16)throw new Error('Invalid push keys.');
  // Web Crypto validates that the point is on P-256 before deriving any secret.
  const publicKey=await crypto.subtle.importKey('raw',receiver,{name:'ECDH',namedCurve:'P-256'},false,[]);
  const shared=new Uint8Array(await crypto.subtle.deriveBits({name:'ECDH',public:publicKey},ephemeral.privateKey,256));
  const sender=new Uint8Array(await crypto.subtle.exportKey('raw',ephemeral.publicKey));
  const ikm=await hkdf(shared,auth,info('WebPush: info',receiver,sender),256);
  const contentKey=await hkdf(ikm,salt,info('Content-Encoding: aes128gcm'),128);
  const nonce=await hkdf(ikm,salt,info('Content-Encoding: nonce'),96);
  const aes=await crypto.subtle.importKey('raw',contentKey,'AES-GCM',false,['encrypt']);
  const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce},aes,concat(payload,new Uint8Array([2]))));
  const header=new Uint8Array(21);header.set(salt);new DataView(header.buffer).setUint32(16,4096,false);header[20]=65;
  return concat(header,sender,encrypted);
}

/** Application-specific sender: public Web Crypto/VAPID APIs, no global fetch patch.
 * The library's pinned sender has no transport hook and follows redirects. Own the
 * small HTTP boundary: manual redirects are rejected as non-2xx in Node and
 * Cloudflare. Workers does not implement fetch redirect:'error'.
 */
export async function sendBrowserPushBatch(subscriptions:readonly PushSubscriptionData[],payload:PushPayload,vapid:VapidConfig,topic:string,transport:typeof fetch=fetch):Promise<SendPushBatchResult>{
  const bytes=encoder.encode(JSON.stringify(payload));
  if(bytes.length>3993||!/^[A-Za-z0-9_-]{1,32}$/.test(topic))throw new Error('Invalid push payload.');
  const result:SendPushBatchResult={delivered:0,gone:[],failed:[]};
  const tokens=new Map<string,Promise<string>>();
  let cursor=0;
  await Promise.all(Array.from({length:Math.min(8,subscriptions.length)},async()=>{
    while(cursor<subscriptions.length){
      const subscription=subscriptions[cursor++];
      try{
        if(!isAllowedPushEndpoint(subscription.endpoint))throw new Error('Unsupported push endpoint.');
        const ephemeral=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
        const body=await encryptPushRecord(bytes,subscription.keys,ephemeral,crypto.getRandomValues(new Uint8Array(16)));
        const audience=new URL(subscription.endpoint).origin;
        if(!tokens.has(audience))tokens.set(audience,createVapidJwt({...vapid,audience}));
        const jwt=await tokens.get(audience);
        const response=await transport(subscription.endpoint,{
          method:'POST',redirect:'manual',credentials:'omit',signal:AbortSignal.timeout(5000),
          headers:{Authorization:`vapid t=${jwt}, k=${vapid.publicKey}`,'Content-Encoding':'aes128gcm','Content-Type':'application/octet-stream',TTL:'86400',Urgency:'high',Topic:topic},body,
        });
        // Status suffices; never read/log a provider response body or capability URL.
        void response.body?.cancel().catch(()=>{});
        if(response.ok)result.delivered++;
        else if(response.status===404||response.status===410)result.gone.push(subscription.endpoint);
        else throw new WebPushError('Push delivery rejected.',response.status,'',subscription.endpoint,response.headers.get('retry-after'));
      }catch(error){result.failed.push({endpoint:subscription.endpoint,error});}
    }
  }));
  return result;
}
