import assert from 'node:assert/strict';

const userContent = [
  {type: 'input_text', text: 'Consultă cele două atașamente sintetice.'},
  {type: 'input_file', filename: 'exemplu.pdf', file_data: 'data:application/pdf;base64,JVBERi0xLjQK'},
  {type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC', detail: 'auto'},
];
const refusal = 'Nu pot determina rezultatul din aceste fișiere.';

function refusalResponse(model, stream) {
  const part = {type: 'refusal', refusal};
  const message = {type: 'message', id: 'msg_media', role: 'assistant', status: 'completed', content: [part]};
  const response = {
    id: 'resp_media', object: 'response', created_at: 1, model, status: 'completed',
    output: [message], error: null, usage: {input_tokens: 10, output_tokens: 5, total_tokens: 15},
  };
  if (!stream) return Response.json(response);

  const eventItem = {item_id: message.id, output_index: 0, content_index: 0};
  const events = [
    {type: 'response.created', response: {...response, status: 'in_progress', output: []}},
    {type: 'response.output_item.added', output_index: 0, item: {...message, status: 'in_progress', content: []}},
    {type: 'response.content_part.added', ...eventItem, part: {type: 'refusal', refusal: ''}},
    {type: 'response.refusal.delta', ...eventItem, delta: refusal},
    {type: 'response.refusal.done', ...eventItem, refusal},
    {type: 'response.content_part.done', ...eventItem, part},
    {type: 'response.output_item.done', output_index: 0, item: message},
    {type: 'response.completed', response},
  ];
  const body = events.map((event, sequence_number) =>
    `event: ${event.type}\ndata: ${JSON.stringify({...event, sequence_number})}\n\n`).join('');
  return new Response(body + 'data: [DONE]\n\n', {headers: {'Content-Type': 'text/event-stream'}});
}

export async function verifyManagerAiMedia(runManagerAi, model) {
  for (const stream of [false, true]) {
    let calls = 0;
    const result = await runManagerAi({
      model, key: 'fixture', turns: [], content: [{role: 'user', content: userContent}],
      signal: new AbortController().signal, check: async () => {},
      readSource: async () => { throw new Error('Unexpected report read'); },
      onEvent: stream ? async () => {} : undefined,
      send: async (input, init) => {
        const request = new Request(input, init);
        assert.equal(new URL(request.url).origin, 'https://api.openai.com');
        assert.equal(request.method, 'POST');
        const body = await request.json();
        assert.equal(body.store, false);
        assert.equal(Boolean(body.stream), stream);
        const user = body.input.findLast((item) => item.role === 'user');
        assert.ok(user, 'the user message must reach Responses');
        assert.deepEqual(user.content.map((part) => part.type), ['input_text', 'input_file', 'input_image']);
        assert.equal(user.content[0].text, userContent[0].text);
        assert.equal(user.content[1].filename, userContent[1].filename);
        assert.equal(user.content[1].file_data, userContent[1].file_data);
        assert.equal(user.content[2].image_url, userContent[2].image_url);
        assert.equal(user.content[2].detail, userContent[2].detail);
        calls++;
        return refusalResponse(model, stream);
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.answer, refusal);
    assert.deepEqual(result.reports, []);
  }
}
