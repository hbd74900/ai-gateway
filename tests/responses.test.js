import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  usesNativeResponses,
  responsesToChatCompletions,
  chatCompletionsToResponses,
  chatCompletionsStreamToResponsesStream,
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

test('responsesToChatCompletions maps Codex reasoning, custom tools, and multimodal input', () => {
  const body = responsesToChatCompletions({
    model: 'gpt',
    input: [
      { type: 'message', role: 'user', content: [
        { type: 'input_text', text: 'look' },
        { type: 'input_image', image_url: 'data:image/png;base64,abc', detail: 'high' },
      ] },
      { type: 'reasoning', encrypted_content: 'opaque', summary: [{ type: 'summary_text', text: 'summary' }] },
      { type: 'custom_tool_call', call_id: 'c1', name: 'apply_patch', input: '*** Begin Patch' },
      { type: 'custom_tool_call_output', call_id: 'c1', output: 'done' },
    ],
    reasoning: { effort: 'high', summary: 'auto' },
    tools: [{ type: 'custom', name: 'apply_patch', description: 'edit', format: { type: 'grammar' } }],
    text: { format: { type: 'json_schema', name: 'answer', schema: { type: 'object' } } },
  }, { openRouter: true });

  assert.deepEqual(body.reasoning, { effort: 'high' });
  assert.equal(body.tools[0].type, 'function');
  assert.equal(body.tools[0].function.name, 'apply_patch');
  assert.equal(body.messages[0].content[1].type, 'image_url');
  assert.ok(body.messages[1].reasoning_details.some((detail) => detail.type === 'reasoning.encrypted'));
  assert.equal(body.messages[1].tool_calls[0].id, 'c1');
  assert.equal(body.messages[2].role, 'tool');
  assert.equal(body.response_format.json_schema.name, 'answer');
});

test('chatCompletionsToResponses preserves reasoning and function-call output shape', () => {
  const result = chatCompletionsToResponses({
    id: 'chatcmpl-1',
    choices: [{
      finish_reason: 'tool_calls',
      message: {
        content: 'done',
        reasoning_details: [{ type: 'reasoning.text', text: 'because', signature: 'sig' }],
        tool_calls: [{ id: 'call-1', function: { name: 'run', arguments: '{"x":1}' } }],
      },
    }],
    usage: { prompt_tokens: 4, completion_tokens: 6, completion_tokens_details: { reasoning_tokens: 2 } },
  }, 'gpt');

  assert.equal(result.object, 'response');
  assert.equal(result.output_text, 'done');
  assert.equal(result.output[0].type, 'reasoning');
  assert.equal(result.output[1].type, 'message');
  assert.equal(result.output[2].type, 'function_call');
  assert.equal(result.output[2].call_id, 'call-1');
  assert.equal(result.usage.output_tokens_details.reasoning_tokens, 2);
});

test('chatCompletionsStreamToResponsesStream emits text, tool, and completion events', async () => {
  const wire = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'hello' } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'run', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })}`,
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2 } })}`,
    'data: [DONE]',
    '',
  ].join('\n\n');
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(wire));
      controller.close();
    },
  });
  const { stream, usagePromise } = chatCompletionsStreamToResponsesStream(source, 'gpt');
  const output = await new Response(stream).text();
  assert.match(output, /response\.output_text\.delta/);
  assert.match(output, /response\.function_call_arguments\.delta/);
  assert.match(output, /response\.function_call_arguments\.done/);
  assert.match(output, /response\.completed/);
  assert.deepEqual(await usagePromise, { prompt_tokens: 1, completion_tokens: 2 });
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
