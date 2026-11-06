import { createReadCache } from '../../shared/read-cache.mjs';
import type { Settings } from './types';
const storagePrefix = 'astral.read-cache.v1:';
const stores = new Map<string, string>();
const warming = new Map<string, Promise<void>>();
let epoch = 0,
  timer: ReturnType<typeof setTimeout> | undefined;
export const resourceCache = createReadCache({
  onChange: () => {
    if (typeof sessionStorage === 'undefined' || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      for (const [scope, key] of stores) {
        const records = resourceCache.snapshot().flatMap((row) => {
          const [owner, path] = JSON.parse(row.key);
          return owner === scope ? [{ path, at: row.at, ttl: row.ttl, value: row.value }] : [];
        });
        try {
          sessionStorage.setItem(key, JSON.stringify({ version: 1, records }));
        } catch {
          /* Memory cache remains available. */
        }
      }
    }, 750);
  },
});
export function resourceScope(s: Settings) {
  return JSON.stringify([
    s.url.replace(/\/$/, '') || (typeof location === 'undefined' ? 'local' : location.origin),
    s.sessionToken || s.token || 'guest',
  ]);
}
export const resourceKey = (s: Settings, path: string) => JSON.stringify([resourceScope(s), path]);
export function cacheTTL(path: string): number {
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
    if (typeof sessionStorage === 'undefined' || !globalThis.crypto?.subtle) return;
    try {
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(scope));
      if (born !== epoch) return;
      const key =
        storagePrefix +
        Array.from(new Uint8Array(hash), (n) => n.toString(16).padStart(2, '0')).join('');
      stores.set(scope, key);
      const text = sessionStorage.getItem(key);
      if (!text || text.length > 2 * 1024 * 1024) return;
      const data = JSON.parse(text);
      if (data.version !== 1 || !Array.isArray(data.records) || data.records.length > 120) return;
      for (const row of data.records)
        if (
          typeof row.path === 'string' &&
          (cacheTTL(row.path) || row.path === '/@task-stream') &&
          Number.isFinite(row.at) &&
          row.at <= Date.now() &&
          Date.now() - row.at < 20 * 60 * 1000 &&
          Number.isFinite(row.ttl) &&
          row.ttl > 0 &&
          row.ttl <= 60000
        ) {
          resourceCache.set(
            resourceKey(s, row.path),
            row.value,
            row.at,
            Math.min(row.ttl, cacheTTL(row.path) || 30000),
          );
        }
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
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(storagePrefix)) sessionStorage.removeItem(key);
    }
  } catch {}
}
