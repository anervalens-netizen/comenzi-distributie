import {AsyncLocalStorage} from 'node:async_hooks';

export type RequestAuthority = {sql:string; args:(string|number|null)[]; denied:()=>never};
export const writeAuthority = new AsyncLocalStorage<RequestAuthority>();
