import { createReadCache } from '../../shared/read-cache.mjs';
import type { Settings } from './types';
// Only display snapshots survive an application restart. API freshness remains
// short; restored labels/history never stand in for live permission checks.
const storagePrefix = 'astral.read-cache.v2:';
const legacyPrefix = 'astral.read-cache.v1:';
const retention = 7 * 86400000;
const maxStoredChars = 2 * 1024 * 1024;
const maxEntries = 240;
const stores = new Map<string, string>();
const warming = new Map<string, Promise<void>>();
let epoch = 0,
  timer: ReturnType<typeof setTimeout> | undefined;
function storage(kind: 'local' | 'session'): Storage | undefined {
  try {
    return kind === 'local' ? globalThis.localStorage : globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}
function displayPath(path: string) {
  return /^(?:\/assistant\/(?:project-management|conversations\?targets=deferred|targets(?:\?backend=pi)?)|\/pi\/(?:projects|preferences|skills|conversations(?:\?archived=(?:include|only)|\/[a-f0-9-]{36}(?:\?before=\d+)?)?)|\/goals(?:\?archived=true)?|\/learning\/(?:settings|lessons(?:\?.*|\/[a-f0-9-]{36})?|wrong(?:\?.*)?)|\/relay\/(?:devices|projects(?:\?.*)?|conversations(?:\?.*|\/[a-f0-9-]{36})?)|\/social\/unread|\/mail\/unread|\/@task-stream|\/@dsh-display\/[^/]+|\/@dsh-directory)$/.test(
    path,
  );
}
function containsLearningMaterial(path: string, value: unknown) {
  return (
    path.startsWith('/learning/lessons/') &&
    !!(value as { lesson?: { sections?: unknown } } | null)?.lesson?.sections
  );
}
export function flushResourceCaches() {
  if (timer) clearTimeout(timer);
  timer = undefined;
  const rows = resourceCache.snapshot();
  for (const [scope, key] of stores) {
    const records: { path: string; at: number; ttl: number; value: unknown }[] = [];
    let chars = 64;
    for (const row of rows.slice().sort((a, b) => b.at - a.at)) {
      const [owner, path] = JSON.parse(row.key);
      if (owner !== scope || !displayPath(path) || containsLearningMaterial(path, row.value))
        continue;
      const record = { path, at: row.at, ttl: row.ttl, value: row.value };
      const length = JSON.stringify(record).length + 1;
      if (chars + length > maxStoredChars) continue;
      chars += length;
      records.push(record);
    }
    const text = JSON.stringify({ version: 2, savedAt: Date.now(), records });
    // Keep the total durable cache bounded as accounts/servers change. Other
    // application storage is never evicted to make room for this cache.
    const durable = storage('local');
    try {
      const old: { key: string; size: number; savedAt: number }[] = [];
      for (let i = 0; durable && i < durable.length; i++) {
        const name = durable.key(i);
        if (!name?.startsWith(storagePrefix) || name === key) continue;
        const value = durable.getItem(name) || '';
        let savedAt = 0;
        try {
          savedAt = JSON.parse(value).savedAt || 0;
        } catch {}
        old.push({ key: name, size: value.length, savedAt });
      }
      let total = text.length + old.reduce((n, row) => n + row.size, 0);
      for (const row of old.sort((a, b) => a.savedAt - b.savedAt)) {
        if (total <= maxStoredChars) break;
        durable?.removeItem(row.key);
        total -= row.size;
      }
      durable?.setItem(key, text);
    } catch {
      /* The bounded session copy is still available. */
    }
    try {
      storage('session')?.setItem(key, text);
    } catch {}
  }
}
export const resourceCache = createReadCache({
  maxEntries,
  maxBytes: 8 * 1024 * 1024,
  retention,
  onChange: () => {
    if ((!storage('local') && !storage('session')) || timer) return;
    timer = setTimeout(flushResourceCaches, 750);
  },
});
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushResourceCaches);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) flushResourceCaches();
  });
}
export function resourceScope(s: Settings) {
  return JSON.stringify([
    s.url.replace(/\/$/, '') || (typeof location === 'undefined' ? 'local' : location.origin),
    s.sessionToken || s.token || 'guest',
  ]);
}
export const resourceKey = (s: Settings, path: string) => JSON.stringify([resourceScope(s), path]);
export function cacheTTL(path: string): number {
  if (path === '/assistant/conversations?targets=deferred') return 10000;
  if (path === '/assistant/targets' || path === '/assistant/targets?backend=pi') return 15000;
  if (path === '/assistant/project-management') return 15000;
  if (path === '/social/unread') return 5000;
  if (path === '/mail/unread') return 60000;
  if (path === '/learning/settings') return 30000;
  if (
    path === '/learning/lessons' ||
    path.startsWith('/learning/lessons?') ||
    path.startsWith('/learning/wrong')
  )
    return 15000;
  if (/^\/learning\/lessons\/[a-f0-9-]{36}$/.test(path)) return 60000;
  if (path.startsWith('/relay/')) return path.startsWith('/relay/projects') ? 15000 : 3000;
  if (path === '/pi/status') return 15000;
  if (path === '/pi/projects' || path === '/pi/preferences') return 30000;
  if (
    /^\/(?:pi\/conversations(?:\?archived=(?:include|only))?|goals(?:\?archived=true)?)$/.test(path)
  )
    return 10000;
  if (/^\/pi\/conversations\/[a-f0-9-]{36}(?:\?before=\d+)?$/.test(path)) return 60000;
  if (path === '/pi/skills') return 15000;
  return 0;
}
export async function warmResourceCache(s: Settings) {
  const scope = resourceScope(s);
  if (warming.has(scope)) return warming.get(scope);
  const born = epoch;
  const work = (async () => {
    if (!globalThis.crypto?.subtle) return;
    try {
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(scope));
      if (born !== epoch) return;
      const digest = Array.from(new Uint8Array(hash), (n) => n.toString(16).padStart(2, '0')).join(
        '',
      );
      const key = storagePrefix + digest;
      stores.set(scope, key);
      let text: string | null | undefined;
      for (const store of [storage('local'), storage('session')]) {
        try {
          text = store?.getItem(key);
          if (text) break;
        } catch {}
      }
      if (!text) {
        try {
          text = storage('session')?.getItem(legacyPrefix + digest);
        } catch {}
      }
      if (!text || text.length > maxStoredChars) return;
      const data = JSON.parse(text);
      if (
        ![1, 2].includes(data.version) ||
        !Array.isArray(data.records) ||
        data.records.length > maxEntries
      )
        return;
      for (const row of data.records)
        if (
          typeof row.path === 'string' &&
          displayPath(row.path) &&
          !containsLearningMaterial(row.path, row.value) &&
          Number.isFinite(row.at) &&
          row.at <= Date.now() &&
          Date.now() - row.at < retention &&
          Number.isFinite(row.ttl) &&
          row.ttl > 0 &&
          row.ttl <= 60000
        ) {
          resourceCache.set(
            resourceKey(s, row.path),
            row.value,
            row.at,
            Math.min(row.ttl, cacheTTL(row.path) || 30000),
            true,
          );
        }
      try {
        storage('session')?.removeItem(legacyPrefix + digest);
      } catch {}
    } catch {
      /* Corrupt or unavailable storage is disposable. */
    }
  })();
  warming.set(scope, work);
  return work;
}
export const peekAPI = <T>(s: Settings, path: string): T | undefined =>
  resourceCache.peek(resourceKey(s, path)) as T | undefined;
export function setAPICache(s: Settings, path: string, value: unknown) {
  resourceCache.set(resourceKey(s, path), value, Date.now(), cacheTTL(path) || 30000);
}
export function invalidateAPI(s: Settings, prefix = '', exact = false) {
  const scope = resourceScope(s);
  resourceCache.invalidate((key: string) => {
    const [owner, path] = JSON.parse(key);
    return owner === scope && (exact ? path === prefix : path.startsWith(prefix));
  });
}
export function clearResourceCaches() {
  epoch++;
  if (timer) clearTimeout(timer);
  timer = undefined;
  stores.clear();
  warming.clear();
  resourceCache.clear();
  if (timer) clearTimeout(timer);
  timer = undefined;
  for (const store of [storage('local'), storage('session')]) {
    try {
      for (let i = (store?.length || 0) - 1; i >= 0; i--) {
        const key = store!.key(i);
        if (key?.startsWith(storagePrefix) || key?.startsWith(legacyPrefix)) store!.removeItem(key);
      }
    } catch {}
  }
}
