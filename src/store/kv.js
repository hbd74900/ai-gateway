const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

class KVStore {
  constructor(kv) {
    this.kv = kv;
    this.cache = new Map();
  }

  async get(key) {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.time < CACHE_TTL) {
      return cached.value;
    }
    const value = await this.kv.get(key, 'json');
    this.cache.set(key, { value, time: Date.now() });
    return value;
  }

  async set(key, value) {
    await this.kv.put(key, JSON.stringify(value));
    this.cache.set(key, { value, time: Date.now() });
  }

  invalidate(key) {
    this.cache.delete(key);
  }

  async getChannels() {
    return (await this.get('config:channels')) || [];
  }

  async saveChannels(channels) {
    await this.set('config:channels', channels);
  }

  async getApiKeys() {
    return (await this.get('config:apikeys')) || [];
  }

  async saveApiKeys(keys) {
    await this.set('config:apikeys', keys);
  }

  async getRRCounter(channelId) {
    const val = await this.kv.get(`lb:rr:${channelId}`);
    return parseInt(val) || 0;
  }

  async setRRCounter(channelId, value) {
    await this.kv.put(`lb:rr:${channelId}`, String(value));
  }
}

export function createStore(kv) {
  return new KVStore(kv);
}
