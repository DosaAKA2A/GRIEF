// Cache TTL en memoria, clave -> valor. Vive a nivel de modulo en quien lo use,
// asi sobrevive a los re-auth (la RemoteApi se recrea, el cache no).
export class TtlCache {
  #map = new Map();

  constructor(ttlMs) {
    this.ttl = ttlMs;
  }

  get(key) {
    const e = this.#map.get(key);
    if (!e) return undefined;
    if (Date.now() > e.expires) {
      this.#map.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key, value) {
    this.#map.set(key, { value, expires: Date.now() + this.ttl });
  }
}
