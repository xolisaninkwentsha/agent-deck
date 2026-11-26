// In-memory key-value store for tests. Implements the same four async methods as the
// Durable Object adapter. Values are deep-cloned on the way in and out.
export class MemoryStore {
  constructor() {
    this.map = new Map();
  }

  async get(key) {
    return this.map.has(key) ? structuredClone(this.map.get(key)) : undefined;
  }

  async put(key, value) {
    this.map.set(key, structuredClone(value));
  }

  async delete(key) {
    this.map.delete(key);
  }

  async list(prefix = '') {
    const keys = [...this.map.keys()].filter((k) => k.startsWith(prefix)).sort();
    return new Map(keys.map((k) => [k, structuredClone(this.map.get(k))]));
  }
}
