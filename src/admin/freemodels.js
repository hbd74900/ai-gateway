const CATALOG_URL = 'https://openrouter.ai/api/v1/models';
const CACHE_KEY = 'freemodels:catalog';
const CACHE_TTL_SECONDS = 6 * 60 * 60;

export async function getFreeModelsCatalog(env) {
  let cached = null;
  try {
    cached = await env.KV.get(CACHE_KEY, 'json');
  } catch {}
  if (cached?.fetched_at) {
    return { ...cached, cached: true };
  }
  return await fetchCatalog(env);
}

export async function refreshFreeModelsCatalog(env) {
  return await fetchCatalog(env);
}

async function fetchCatalog(env) {
  const resp = await fetch(CATALOG_URL, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) {
    throw new Error(`openrouter /models returned HTTP ${resp.status}`);
  }
  const data = await resp.json();
  const models = (data?.data || [])
    .filter(m => typeof m.id === 'string' && m.id.endsWith(':free'))
    .map(m => ({
      id: m.id,
      name: m.name || m.id,
      context_length: m.context_length ?? null,
      prompt_price: m.pricing?.prompt ?? null,
      completion_price: m.pricing?.completion ?? null,
      supported_parameters: Array.isArray(m.supported_parameters) ? m.supported_parameters : [],
      input_modalities: m.architecture?.input_modalities || [],
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (models.length === 0) {
    throw new Error('openrouter /models returned no :free variants');
  }
  const catalog = {
    source: 'openrouter',
    fetched_at: new Date().toISOString(),
    cached: false,
    count: models.length,
    models,
  };
  try {
    await env.KV.put(CACHE_KEY, JSON.stringify(catalog), { expirationTtl: CACHE_TTL_SECONDS });
  } catch {}
  return catalog;
}
