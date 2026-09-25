import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  claudeToOpenAI,
  openAIToClaude,
  openAIStreamToClaudeStream,
  observeClaudeStream,
  usesNativeMessages,
} from '../src/proxy/claude.js';

test('usesNativeMessages detects OpenRouter and explicit modes', () => {
  assert.equal(usesNativeMessages({ base_url: 'https://openrouter.ai/api/v1' }), true);
  assert.equal(usesNativeMessages({ base_url: 'https://openrouter.ai/api/v1/' }), true);
  assert.equal(usesNativeMessages({ base_url: 'https://api.anthropic.com/v1' }), true);
  assert.equal(usesNativeMessages({ base_url: 'https://openrouter.ai/api/v1', messages_mode: 'chat' }), false);
  assert.equal(usesNativeMessages({ base_url: 'https://example.com/v1', messages_mode: 'native' }), true);
  assert.equal(usesNativeMessages({ base_url: 'https://example.com/v1' }), false);
});

test('observeClaudeStream is lossless and captures cumulative usage', async () => {
  const wire = [
    'event: message_start',
    `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 4, output_tokens: 0 } } })}`,
    '',
    'event: message_delta',
    `data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 7 } })}`,
    '',
    '',
  ].join('\n');
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(wire));
      controller.close();
    },
  });
  const observed = observeClaudeStream(source);
  const text = await new Response(observed.stream).text();
  assert.match(text, /event: message_start/);
  assert.match(text, /event: message_delta/);
  assert.deepEqual(await observed.usagePromise, { input_tokens: 4, output_tokens: 7 });
});

test('claudeToOpenAI maps adaptive thinking effort and structured output', () => {
  const body = claudeToOpenAI({
    model: 'anthropic/claude-sonnet-4',
    max_tokens: 16000,
    messages: [{ role: 'user', content: 'hello' }],
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'high',
      format: { type: 'json_schema', schema: { type: 'object' } },
    },
    tool_choice: { type: 'tool', name: 'lookup', disable_parallel_tool_use: true },
    tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
  }, { openRouter: true });

  assert.deepEqual(body.reasoning, { effort: 'high' });
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.strict, false);
  assert.deepEqual(body.tool_choice, { type: 'function', function: { name: 'lookup' } });
  assert.equal(body.parallel_tool_calls, false);
  assert.equal(body.tools[0].type, 'function');
});

test('claudeToOpenAI does not guess a thinking budget for generic Chat APIs', () => {
  assert.throws(() => claudeToOpenAI({
    model: 'm', max_tokens: 4096,
    messages: [{ role: 'user', content: 'hi' }],
    thinking: { type: 'enabled', budget_tokens: 2048 },
  }), /budget-based thinking/);
});

test('claudeToOpenAI maps legacy thinking budget to OpenRouter max_tokens', () => {
  const body = claudeToOpenAI({
    model: 'm',
    max_tokens: 4096,
    messages: [{ role: 'user', content: 'hi' }],
    thinking: { type: 'enabled', budget_tokens: 2048 },
  }, { openRouter: true });
  assert.deepEqual(body.reasoning, { max_tokens: 2048 });
});

test('claudeToOpenAI preserves OpenRouter reasoning details and tool results', () => {
  const body = claudeToOpenAI({
    model: 'm',
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'step', signature: 'sig' },
          { type: 'tool_use', id: 'call-1', name: 'run', input: { x: 1 } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call-1', content: [{ type: 'text', text: 'ok' }] },
          { type: 'text', text: 'continue' },
        ],
      },
    ],
  }, { openRouter: true });

  assert.equal(body.messages[0].role, 'assistant');
  assert.equal(body.messages[0].reasoning_details[0].signature, 'sig');
  assert.equal(body.messages[0].tool_calls[0].id, 'call-1');
  assert.deepEqual(body.messages[1], { role: 'tool', tool_call_id: 'call-1', content: 'ok' });
  assert.deepEqual(body.messages[2], { role: 'user', content: 'continue' });
});

test('openAIToClaude converts reasoning, refusal, tools, and usage', () => {
  const result = openAIToClaude({
    model: 'upstream',
    choices: [{
      finish_reason: 'tool_calls',
      message: {
        content: 'answer',
        reasoning_details: [{ type: 'reasoning.text', text: 'think', signature: 'sig' }],
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'run', arguments: '{"x":1}' } }],
      },
    }],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 3 },
      completion_tokens_details: { reasoning_tokens: 2 },
    },
  }, 'requested');

  assert.equal(result.model, 'requested');
  assert.equal(result.content[0].type, 'thinking');
  assert.equal(result.content[1].text, 'answer');
  assert.equal(result.content[2].type, 'tool_use');
  assert.deepEqual(result.content[2].input, { x: 1 });
  assert.equal(result.stop_reason, 'tool_use');
  assert.equal(result.usage.cache_read_input_tokens, 3);
  assert.equal(result.usage.output_tokens_details.thinking_tokens, 2);
});

test('openAIStreamToClaudeStream emits a valid Claude event lifecycle', async () => {
  const wire = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'run', arguments: '{}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 2, completion_tokens: 3 } })}`,
    'data: [DONE]',
    '',
  ].join('\n\n');
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(wire));
      controller.close();
    },
  });

  const output = await new Response(openAIStreamToClaudeStream(source, 'm')).text();
  assert.match(output, /event: message_start/);
  assert.match(output, /event: content_block_start/);
  assert.match(output, /event: content_block_delta/);
  assert.match(output, /event: content_block_stop/);
  assert.match(output, /event: message_delta/);
  assert.match(output, /event: message_stop/);
  assert.doesNotMatch(output, /"index":\{"id"/);
  assert.match(output, /"stop_reason":"tool_use"/);
});
