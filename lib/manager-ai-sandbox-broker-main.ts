import { Socket } from 'node:net';
import { serveSandboxConnection } from './manager-ai-sandbox-broker';

// Accept=yes and StandardInput=socket supply one already-connected, full-duplex socket.
await serveSandboxConnection(new Socket({fd:0,readable:true,writable:true}));
