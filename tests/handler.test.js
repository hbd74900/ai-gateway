import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleProxy } from '../src/proxy/handler.js';

function makeStore(channel) {
  return {
    async getApiKeys() { return [{ id: 'client', key: 'client-key', enabled: true, channel_ids: [] }]; },
    async getChannels() { return [channel]; },
    async getUsage() { return {}; },
    async getRateLimits() { return {}; },
    isRateLimitedWithData() { return false; },
    checkQuotaWithData() { return { allowed: true }; },
    async getModelCache() { return channel.models; },
    async setModelCache() {},
    invalidateModelCache() {},
    async getOrderedKeys() { return channel.keys; },
    async incrementUsage() {},
    async incrementApiKeyUsage() {},
    async clearRateLimitCooldown() {},
    async updateRateLimitHeaders() {},
    async appendError() {},
  };
}

test('Claude count_tokens uses the native upstream endpoint', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init };
    return new Response(JSON.stringify({ input_tokens: 12 }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };
  const channel = {
    id: 'or', name: 'OpenRouter', base_url: 'https://openrouter.ai/api/v1',
    keys: ['upstream-key'], models: ['m'], enabled: true, priority: 0, weight: 1,
  };
  const request = new Request('https://gw.test/v1/messages/count_tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer client-key', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
  });
  const response = await handleProxy(request, {}, makeStore(channel));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { input_tokens: 12 });
  assert.match(captured.url, /\/messages\/count_tokens$/);
});

test('model discovery preserves upstream reasoning capability metadata', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: [{ id: 'm', owned_by: 'upstream', reasoning: { supported_efforts: ['max'] }, supported_parameters: ['reasoning'] }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const channel = {
    id: 'or', name: 'OpenRouter', base_url: 'https://openrouter.ai/api/v1',
    keys: ['upstream-key'], models: ['m'], enabled: true, priority: 0, weight: 1,
  };
  const request = new Request('https://gw.test/v1/models', {
    headers: { Authorization: 'Bearer client-key' },
  });
  const response = await handleProxy(request, {}, makeStore(channel));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.data[0].reasoning, { supported_efforts: ['max'] });
  assert.deepEqual(body.data[0].supported_parameters, ['reasoning']);
});

test('Claude Messages uses OpenRouter native endpoint without lossy conversion', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init };
    return new Response(JSON.stringify({
      id: 'msg_1', type: 'message', role: 'assistant', model: 'm',
      content: [{ type: 'thinking', thinking: 'kept', signature: 'sig' }],
      stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 2, output_tokens: 3 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const channel = {
    id: 'or', name: 'OpenRouter', base_url: 'https://openrouter.ai/api/v1',
    keys: ['upstream-key'], models: ['m'], enabled: true, priority: 0, weight: 1,
  };
  const request = new Request('https://gw.test/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer client-key', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'm', max_tokens: 1024, stream: false,
      thinking: { type: 'adaptive' }, output_config: { effort: 'max' },
      messages: [{ role: 'user', content: 'hello' }],
    }),
  });
  const response = await handleProxy(request, {}, makeStore(channel));
  assert.equal(response.status, 200);
  assert.match(captured.url, /openrouter\.ai\/api\/v1\/messages$/);
  assert.equal(JSON.parse(captured.init.body).thinking.type, 'adaptive');
  assert.equal(JSON.parse(captured.init.body).output_config.effort, 'max');
  assert.equal(captured.init.headers.get('anthropic-version'), '2023-06-01');
  assert.equal(captured.init.headers.get('authorization'), 'Bearer upstream-key');
});

test('Chat fallback preserves the final usage-only SSE chunk in Claude output', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const wire = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}`,
    `data: ${JSON.stringify({ choices: null, usage: { prompt_tokens: 6, completion_tokens: 8 } })}`,
    'data: [DONE]',
    '',
  ].join('\n\n');
  globalThis.fetch = async () => new Response(wire, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });

  const channel = {
    id: 'nv', name: 'NVIDIA', base_url: 'https://integrate.api.nvidia.com/v1',
    keys: ['upstream-key'], models: ['m'], enabled: true, priority: 0, weight: 1,
  };
  const request = new Request('https://gw.test/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer client-key' },
    body: JSON.stringify({ model: 'm', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const response = await handleProxy(request, {}, makeStore(channel));
  assert.equal(response.status, 200);
  const output = await response.text();
  assert.match(output, /event: message_delta/);
  assert.match(output, /"input_tokens":6/);
  assert.match(output, /"output_tokens":8/);
});

test('native Responses non-stream returns the upstream response, not the request', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({
    id: 'resp_upstream', object: 'response', status: 'completed',
    output: [{ type: 'message', role: 'assistant', content: [] }],
    usage: { input_tokens: 4, output_tokens: 5, total_tokens: 9 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  const channel = {
    id: 'or', name: 'OpenRouter', base_url: 'https://openrouter.ai/api/v1',
    keys: ['upstream-key'], models: ['m'], enabled: true, priority: 0, weight: 1,
  };
  const request = new Request('https://gw.test/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer client-key' },
    body: JSON.stringify({ model: 'm', input: 'hello', previous_response_id: 'resp_prev', reasoning: { effort: 'max' } }),
  });
  const response = await handleProxy(request, {}, makeStore(channel));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.id, 'resp_upstream');
  assert.equal(body.object, 'response');
  assert.equal(body.usage.input_tokens, 4);
});
