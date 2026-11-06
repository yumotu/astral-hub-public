// Bounded reads only. A write/clear invalidates pending generations as well as stored values.
export function createReadCache({
  now = Date.now,
  maxEntries = 120,
  maxBytes = 4 * 1024 * 1024,
  onChange = () => {},
} = {}) {
  const entries = new Map(),
    pending = new Map();
  let epoch = 0;
  const versions = new Map();
  const clone = (value) => structuredClone(value);
  function trim() {
    let bytes = [...entries.values()].reduce((n, row) => n + row.bytes, 0);
    for (const [key, row] of entries) {
      if (entries.size <= maxEntries && bytes <= maxBytes) break;
      entries.delete(key);
      bytes -= row.bytes;
    }
  }
  function set(key, value, at = now(), ttl = 30000) {
    const serialized = JSON.stringify(value);
    if (!serialized || serialized.length * 2 > maxBytes) return;
    entries.delete(key);
    entries.set(key, { value: clone(value), at, ttl, bytes: serialized.length * 2 });
    trim();
    onChange();
  }
  const peek = (key) => {
    const row = entries.get(key);
    return row && now() - row.at < 20 * 60 * 1000 ? clone(row.value) : undefined;
  };
  async function read(key, load, { ttl = 30000, force = false } = {}) {
    const row = entries.get(key);
    if (!force && row && now() - row.at < row.ttl) return clone(row.value);
    if (pending.has(key)) return clone(await pending.get(key));
    const born = epoch,
      version = versions.get(key) || 0;
    const promise = Promise.resolve()
      .then(load)
      .then((value) => {
        if (born === epoch && (versions.get(key) || 0) === version) set(key, value, now(), ttl);
        return value;
      });
    pending.set(key, promise);
    try {
      return clone(await promise);
    } finally {
      if (pending.get(key) === promise) pending.delete(key);
    }
  }
  function invalidate(match = (key) => true) {
    for (const key of new Set([...entries.keys(), ...pending.keys()]))
      if (match(key)) {
        entries.delete(key);
        pending.delete(key);
        versions.set(key, (versions.get(key) || 0) + 1);
      }
    onChange();
  }
  function clear() {
    epoch++;
    entries.clear();
    pending.clear();
    versions.clear();
    onChange();
  }
  return {
    read,
    peek,
    set,
    invalidate,
    clear,
    snapshot: () =>
      [...entries]
        .filter(([, row]) => now() - row.at < 20 * 60 * 1000)
        .map(([key, row]) => ({ key, at: row.at, ttl: row.ttl, value: clone(row.value) })),
  };
}
