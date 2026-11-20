import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { browserFixture, delay, waitFor } from './offline-browser-fixture.mjs';

const bundle = await build({
  stdin: { resolveDir: resolve('.'), loader: 'tsx', contents: String.raw`
import {createRoot} from 'react-dom/client';
import {AiApiContext} from './components/ai-assistant/api-context';
import {AiPanelHeader} from './components/ai-assistant/AiPanelHeader';
import {useAiAssistant} from './components/ai-assistant/useAiAssistant';

const timeout = window.setTimeout.bind(window);
window.setTimeout = (callback, ms, ...args) => timeout(callback, ms === 2000 ? 40 : ms, ...args);
const timestamp = '2026-11-20T09:00:00Z';
const existing = ['first', 'other'].map(id => ({id, title:id, effort:'high', createdAt:timestamp, updatedAt:timestamp}));
const message = (id, role, text, ordinal, status='complete') => ({id, role, text, ordinal, status, createdAt:timestamp});
const raw = value => ({...value, created_at:value.createdAt});
const userA = message('a', 'user', 'Question A', 1);
const finalA = message('answer-a', 'assistant', 'Final A', 2);
const userB = message('b', 'user', 'Question B', 3);
const stoppedB = message('answer-b', 'assistant', 'Partial B saved', 4, 'stopped');
const status = (id, state, terminal_message_id = null) => ({submission_id:id, state, run_state:state, terminal_message_id});
const persisted = [];
const fixture = window.fixture = {reads:[], probes:[], streams:{}, stops:[], newCount:0, settledB:false, chat:null, releaseA:null};
const api = {
  listAiConversations: async () => existing,
  createAiConversation: async () => { fixture.newCount += 1; return existing[1]; },
  listAiMessages: async (id) => {
    fixture.reads.push(id);
    return {items:fixture.settledB ? [userA, finalA, userB, stoppedB, ...persisted] : [], hasMore:false};
  },
  getAiSubmissionStatus: async (id, submissionId) => {
    fixture.probes.push(submissionId);
    if (submissionId === 'a') return new Promise(resolve => {
      fixture.releaseA = () => resolve(status('a', 'complete', 'answer-a'));
    });
    if (submissionId === 'b') return fixture.settledB ? status('b', 'stopped', 'answer-b') : status('b', 'running');
    return status(submissionId, submissionId, submissionId === 'error' ? 'provider-error' : null);
  },
  openAiTurnStream: async (id, submission, signal) => new Response(new ReadableStream({
    start(controller) {
      const submissionId = submission.submissionId;
      fixture.streams[submissionId] = {controller, signal};
      if (submissionId === 'a' || submissionId === 'b') return;
      if (submissionId !== 'rejected') {
        const file = submission.files[0];
        persisted.push({...message(submissionId, 'user', submission.text, 5 + persisted.length),
          attachments:[{id:'artifact-'+submissionId, kind:'input', filename:file.name, mimeType:file.type, sizeBytes:file.size}]});
        if (submissionId === 'error') persisted.push(message('provider-error', 'assistant', 'Provider failed', 5 + persisted.length, 'error'));
      }
      // The server stored the message and its attachments before delivery was lost.
      controller.close();
    },
  })),
  stopAiTurn: async (id, submissionId) => { fixture.stops.push(submissionId); },
};
const encoder = new TextEncoder();
function emit(id, event) {
  fixture.streams[id].controller.enqueue(encoder.encode(JSON.stringify(event)+'\n'));
}
fixture.ask = (id, files=[]) => {
  const result = fixture.chat.submit({
    submissionId:id, mode:'send', text:'Question '+id, effort:'high', files,
    includeCurrentView:false, currentView:null,
  });
  fixture.admission = result;
};
fixture.progress = (id, text) => {
  emit(id, {type:'submission_status', ...status(id, 'running')});
  emit(id, {type:'user_message', message:raw(id === 'a' ? userA : userB)});
  emit(id, {type:'delta', text});
};
fixture.finalA = () => emit('a', {type:'complete', message:raw(finalA)});
fixture.lateA = () => {
  fixture.releaseA();
  emit('a', {type:'delta', text:'Old delivery'});
  fixture.streams.a.controller.close();
};
function Chat() {
  const chat = useAiAssistant(true, 'synthetic-manager-ai');
  fixture.chat = chat;
  return <AiPanelHeader {...chat} onSelectConversation={chat.selectConversation}
    onNewConversation={chat.newConversation} onResetWidth={()=>{}} onClose={()=>{}}/>;
}
createRoot(document.querySelector('#root')).render(<AiApiContext.Provider value={api}><Chat/></AiApiContext.Provider>);
` },
  write:false, bundle:true, format:'esm', platform:'browser', jsx:'automatic',
  define:{'process.env.NODE_ENV':'"production"'},
  alias:{'next/image':resolve('tools/offline-image.tsx')},
});
const js = bundle.outputFiles[0].text;
const server = createServer((req, res) => {
  const script = req.url === '/fixture.js';
  res.setHeader('Content-Type', script ? 'text/javascript' : 'text/html');
  res.end(script ? js : '<!doctype html><meta charset=utf-8><div id=root></div><script type=module src=/fixture.js></script>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await browserFixture('http://127.0.0.1:'+server.address().port);
  const evaluate = expression => browser.evaluate(expression);
  const wait = (expression, label) => waitFor(() => evaluate(expression), label);
  const locked = "document.querySelector('select').disabled && document.querySelector('button[aria-label=\"Sesiune nouă\"]').disabled";
  await wait("fixture.chat?.runStatus === 'idle'", 'initial conversation');
  await evaluate("fixture.ask('a')");
  await wait("!!fixture.streams.a", 'first delivery');
  await evaluate("fixture.progress('a', 'Partial A')");
  await wait('!!fixture.releaseA', 'first turn has an outstanding status probe');
  assert.equal(await evaluate(locked), true, 'session controls are locked during analysis');
  await evaluate("Promise.all([fixture.chat.newConversation(), fixture.chat.selectConversation('other')])");
  assert.deepEqual(await evaluate('[fixture.newCount, fixture.chat.conversationId, fixture.reads.length]'), [0, 'first', 1]);

  await evaluate('fixture.finalA()');
  await wait("fixture.chat.runStatus === 'idle' && fixture.chat.messages.at(-1)?.text === 'Final A'", 'first terminal frame');
  await evaluate("fixture.ask('b')");
  await wait("!!fixture.streams.b", 'next turn in the same conversation');
  await evaluate("fixture.progress('b', 'Partial B')");
  await wait("fixture.chat.messages.at(-1)?.text === 'Partial B'", 'next turn is streaming');
  await evaluate('fixture.lateA()');
  await wait("fixture.probes.filter(id => id === 'b').length >= 2", 'active stream status probes');
  assert.equal(await evaluate('fixture.reads.length'), 1, 'active polling never loads the transcript');
  assert.deepEqual(await evaluate('[fixture.chat.runStatus, fixture.chat.messages.at(-1).text]'), ['running', 'Partial B']);

  await evaluate('fixture.chat.stop()');
  await wait("fixture.chat.runStatus === 'stopping'", 'stop pending');
  assert.equal(await evaluate(locked), true, 'session controls stay locked during stop');
  assert.deepEqual(await evaluate('fixture.stops'), ['b']);
  await evaluate('fixture.settledB = true');
  await wait("fixture.chat.runStatus === 'idle' && fixture.chat.messages.at(-1)?.status === 'stopped'", 'durable stop and partial response');
  await delay(150);
  assert.equal(await evaluate(locked), false, 'session controls unlock after durable terminal state');
  assert.deepEqual(await evaluate('[fixture.reads.length, fixture.streams.b.signal.aborted, fixture.chat.messages.at(-1).text]'), [2, true, 'Partial B saved']);
  for (const state of ['error', 'interrupted', 'rejected']) {
    await evaluate(`fixture.ask('${state}', [new File(['synthetic file'], 'evidence.txt', {type:'text/plain'})])`);
    const expectedOutcome = state === 'rejected' ? 'rejected' : 'accepted';
    assert.deepEqual(await evaluate('fixture.admission'), {outcome:expectedOutcome}, `admission after lost delivery with durable ${state} status`);
    await wait("fixture.chat.runStatus === 'idle'", `recovered ${state} status`);
    const savedAttachments = await evaluate(`fixture.chat.messages.filter(message => message.id === '${state}').flatMap(message => message.attachments ?? []).length`);
    assert.equal(savedAttachments, state === 'rejected' ? 0 : 1);
  }
  console.log('Manager AI admission recovery, turn generation, navigation lock and status-only polling passed.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
