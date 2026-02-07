export async function verifyApiKey(request, store) {
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) {
    return { valid: false, error: 'Missing or invalid Authorization header' };
  }
  const key = auth.slice(7);
  const apiKeys = await store.getApiKeys();
  const found = apiKeys.find(k => k.key === key && k.enabled);
  if (!found) {
    return { valid: false, error: 'Invalid or disabled API key' };
  }
  return { valid: true, apiKey: found };
}
