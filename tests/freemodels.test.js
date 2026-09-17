import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleAdminApi } from '../src/admin/api.js';

function makeEnv() {
  const data = new Map();
  const store = {
    KV: {
      async get(key, type) {
        if (!data.has(key)) return null;
        const v = data.get(key);
        return type === 'json' ? JSON.parse(v) : v;
      },
      async put(key, value) { data.set(key, value); },
    },
  };
  return { env: store, data };
}

function mockRouterResponse() {
  return {
    data: [
      {
        id: 'openai/gpt-oss-120b:free',
        name: 'GPT-OSS 120B (free)',
        context_length: 131072,
        pricing: { prompt: '0', completion: '0' },
        supported_parameters: ['tools', 'temperature'],
        architecture: { input_modalities: ['text'] },
      },
      {
        id: 'qwen/qwen3-coder:free',
        name: 'Qwen3 Coder (free)',
        context_length: 65536,
        pricing: { prompt: '0', completion: '0' },
        supported_parameters: ['temperature'],
        architecture: { input_modalities: ['text'] },
      },
      {
        id: 'anthropic/claude-sonnet-4.5',
        name: 'Claude Sonnet (paid)',
        context_length: 200000,
        pricing: { prompt: '0.000003', completion: '0.000015' },
        supported_parameters: ['tools'],
        architecture: { input_modalities: ['text'] },
      },
    ],
  };
}

const originalFetch = globalThis.fetch;

test('freemodels endpoint filters :free variants and caches', async (t) => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify(mockRouterResponse()), { status: 200 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const { env, data } = makeEnv();
  const makeReq = (p, m = 'GET') => new Request('https://gw.test/admin/api' + p, { method: m });

  const first = await handleAdminApi(makeReq('/freemodels'), env, {});
  assert.equal(first.status, 200);
  const firstData = await first.json();
  assert.equal(firstData.count, 2);
  assert.deepEqual(firstData.models.map(m => m.id), ['openai/gpt-oss-120b:free', 'qwen/qwen3-coder:free']);
  assert.equal(firstData.cached, false);
  assert.equal(calls, 1);

  const second = await handleAdminApi(makeReq('/freemodels'), env, {});
  const secondData = await second.json();
  assert.equal(secondData.cached, true);
  assert.equal(calls, 1);

  const refreshed = await handleAdminApi(makeReq('/freemodels/refresh', 'POST'), env, {});
  const refreshedData = await refreshed.json();
  assert.equal(refreshedData.cached, false);
  assert.equal(calls, 2);
  assert.ok(data.has('freemodels:catalog'), 'catalog should be written to KV cache');
});

test('freemodels endpoint surfaces upstream errors', async (t) => {
  globalThis.fetch = async () => new Response('{"error":{"message":"boom"}}', { status: 503 });
  t.after(() => { globalThis.fetch = originalFetch; });

  const env = makeEnv();
  const res = await handleAdminApi(new Request('https://gw.test/admin/api/freemodels/refresh', { method: 'POST' }), env, {});
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.match(body.error, /HTTP 503/);
});
