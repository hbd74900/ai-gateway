import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  usesNativeResponses,
  responsesToChatCompletions,
  observeResponsesStream,
} from '../src/proxy/responses.js';

test('usesNativeResponses detects endpoints with native Responses API', () => {
  assert.equal(usesNativeResponses({ base_url: 'https://openrouter.ai/api/v1' }), true);
  assert.equal(usesNativeResponses({ base_url: 'https://api.openai.com/v1' }), true);
  assert.equal(usesNativeResponses({ base_url: 'https://example.com/api/v1/responses/' }), true);
  assert.equal(usesNativeResponses({ base_url: 'https://openrouter.ai/api/v1', responses_mode: 'chat' }), false);
  assert.equal(usesNativeResponses({ base_url: 'https://integrate.api.nvidia.com/v1', responses_mode: 'native' }), true);
  assert.equal(usesNativeResponses({ base_url: 'https://integrate.api.nvidia.com/v1' }), false);
  assert.equal(usesNativeResponses({ base_url: 'not-a-url' }), false);
});

test('responsesToChatCompletions groups consecutive function_call items', () => {
  const result = responsesToChatCompletions({
    model: 'test',
    input: [
      { type: 'function_call', call_id: 'a', name: 'f1', arguments: '{}' },
      { type: 'function_call', call_id: 'b', name: 'f2', arguments: '{}' },
      { role: 'user', content: 'hi' },
    ],
  });
  const assistant = result.messages[0];
  assert.equal(assistant.role, 'assistant');
  assert.equal(assistant.tool_calls.length, 2);
  assert.deepEqual(assistant.tool_calls.map(tc => tc.id), ['a', 'b']);
  assert.equal(result.messages[1].role, 'user');
});

test('responsesToChatCompletions forwards parallel_tool_calls', () => {
  const result = responsesToChatCompletions({
    model: 'm',
    input: 'hi',
    parallel_tool_calls: false,
  });
  assert.equal(result.parallel_tool_calls, false);
});

test('responsesToChatCompletions rejects unsupported stateful features', () => {
  assert.throws(() => responsesToChatCompletions({ model: 'm', input: 'x', previous_response_id: 'r1' }), /previous_response_id/);
  assert.equal(responsesToChatCompletions({ model: 'm', input: 'x', store: true }).stream, false);
});

test('observeResponsesStream passes events through and captures usage', async () => {
  const wire = [
    'event: response.created',
    'data: {"type":"response.created","response":{"usage":null}}',
    '',
    'data: {"response":{"usage":{"input_tokens":7,"output_tokens":3}}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  const bytes = new TextEncoder().encode(wire);
  let pos = 0;
  const source = new ReadableStream({
    pull(ctrl) {
      if (pos >= bytes.length) { ctrl.close(); return; }
      ctrl.enqueue(bytes.slice(pos, pos + 5));
      pos += 5;
    },
  });
  const { stream, usagePromise } = observeResponsesStream(source);
  const out = await new Response(stream).text();
  assert.ok(out.includes('response.created'));
  assert.deepEqual(await usagePromise, { prompt_tokens: 7, completion_tokens: 3 });
});

test('observeResponsesStream settles usagePromise on upstream error', async () => {
  const source = new ReadableStream({
    start(ctrl) { ctrl.error(new Error('boom')); },
  });
  const { stream, usagePromise } = observeResponsesStream(source);
  const reader = stream.getReader();
  await assert.rejects(reader.read(), /boom/);
  assert.deepEqual(await usagePromise, null);
});

test('observeResponsesStream settles usagePromise when client cancels', async () => {
  const source = new ReadableStream({ pull(ctrl) { ctrl.enqueue(new TextEncoder().encode('data: x\n\n')); } });
  const { stream, usagePromise } = observeResponsesStream(source);
  const reader = stream.getReader();
  await reader.read();
  await reader.cancel();
  assert.deepEqual(await usagePromise, null);
});
