// Synthetic Responses fixtures include settled output frames, as the real
// provider does. Native admission deliberately rejects terminal-only tool calls.
export function responseEvents(events) {
  const terminal = events.findLast(event => event.type === 'response.completed');
  const response = terminal?.response;
  const responseId = response?.id ?? 'resp_fixture';
  const output = (response?.output ?? []).map((item, index) => ({
    ...item,
    id: item.id ?? 'item_fixture_' + index,
    ...(item.type === 'message' ? {status: item.status ?? 'completed'} : {}),
  }));
  const frames = [];
  if (!events.some(event => event.type === 'response.created') && response)
    frames.push({type: 'response.created', response: {...response, id: responseId, status: 'in_progress', output: []}});
  const settled = new Set(events.filter(event => event.type === 'response.output_item.done').map(event => event.output_index));
  for (const event of events) {
    if (event.type === 'response.created') {
      frames.push({...event, response: {...event.response, id: event.response.id ?? responseId}});
    } else if (event.type === 'response.completed') {
      for (const [output_index, item] of output.entries())
        if (!settled.has(output_index)) frames.push({type: 'response.output_item.done', output_index, item});
      frames.push({...event, response: {...event.response, id: responseId, output}});
    } else frames.push(event);
  }
  return new Response(frames.map((event, sequence_number) =>
    'event: ' + event.type + '\ndata: ' + JSON.stringify({...event, sequence_number}) + '\n\n').join('') + 'data: [DONE]\n\n',
    {headers: {'Content-Type': 'text/event-stream'}});
}

export function messageText(content) {
  return typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(part => part.type === 'input_text').map(part => part.text).join('')
    : undefined;
}
