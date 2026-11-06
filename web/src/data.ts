import {
  resourceCache,
  resourceKey,
  cacheTTL,
  warmResourceCache,
  invalidateAPI,
  clearResourceCaches,
} from './resource-cache.ts';
import { deck, spreads, readingSchema, pluginSchema } from '../../shared/deck.mjs';
import type { Entry, Reading, Settings, Spread, Plugin } from './types';
import { drawReading } from '../../shared/draw.mjs';
export { deck, spreads };
export function scopedStorageKey(name: string, scope = 'legacy') {
  const key = `astral.${name}:${scope}`;
  // 原先的本机记录只归入管理员/旧令牌空间，不导入其他账号。
  if (
    (scope.endsWith(':legacy') || scope.endsWith(':guest')) &&
    localStorage.getItem(key) === null
  ) {
    const previous = localStorage.getItem(`astral.${name}`);
    if (previous !== null) {
      localStorage.setItem(key, previous);
      localStorage.removeItem(`astral.${name}`);
    }
  }
  return key;
}
export function loadEntries(scope = 'legacy'): Entry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(scopedStorageKey('entries', scope)) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (e: Entry) =>
        typeof e.id === 'string' &&
        typeof e.deleted === 'boolean' &&
        (e.deleted
          ? e.data === null
          : readingSchema.safeParse(e.data).success && e.id === e.data?.id),
    );
  } catch {
    return [];
  }
}
export function loadSettings(): Settings {
  try {
    const p = JSON.parse(localStorage.getItem('astral.settings') || '{}');
    const a = JSON.parse(localStorage.getItem('astral.ai') || '{}');
    return {
      url: typeof p.url === 'string' ? p.url : '',
      token: sessionStorage.getItem('astral.token') || (p.remember ? p.token : '') || '',
      autoSync: !!p.autoSync,
      remember: !!p.remember,
      apiKey: sessionStorage.getItem('astral.apiKey') || (a.rememberKey ? a.apiKey : '') || '',
      model: typeof a.model === 'string' ? a.model : 'deepseek-flash',
      rememberKey: !!a.rememberKey,
      aiMode:
        a.aiMode === 'local' ||
        (!a.aiMode && (sessionStorage.getItem('astral.apiKey') || (a.rememberKey && a.apiKey)))
          ? 'local'
          : 'server',
    };
  } catch {
    return {
      url: '',
      token: '',
      autoSync: false,
      remember: false,
      apiKey: '',
      model: 'deepseek-flash',
      rememberKey: false,
      aiMode: 'server',
    };
  }
}
export function loadScopedAI(
  scope: string,
): Pick<Settings, 'apiKey' | 'model' | 'rememberKey' | 'aiMode' | 'aiScope'> {
  try {
    const key = scopedStorageKey('ai', scope);
    // 升级时将旧版临时密钥移入访客/管理员空间，不能带入另一个成员账号。
    if (
      (scope.endsWith(':guest') || scope.endsWith(':legacy')) &&
      sessionStorage.getItem('astral.apiKey')
    ) {
      sessionStorage.setItem(`astral.apiKey:${scope}`, sessionStorage.getItem('astral.apiKey')!);
      sessionStorage.removeItem('astral.apiKey');
    }
    const a = JSON.parse(localStorage.getItem(key) || '{}');
    const apiKey =
      sessionStorage.getItem(`astral.apiKey:${scope}`) || (a.rememberKey ? a.apiKey : '') || '';
    return {
      apiKey,
      model: typeof a.model === 'string' ? a.model : 'deepseek-flash',
      rememberKey: !!a.rememberKey,
      aiMode: a.aiMode === 'local' || (!a.aiMode && apiKey) ? 'local' : 'server',
      aiScope: scope,
    };
  } catch {
    return {
      apiKey: '',
      model: 'deepseek-flash',
      rememberKey: false,
      aiMode: 'server',
      aiScope: scope,
    };
  }
}
export function validateSettings(s: Settings) {
  if (!s.model.trim() || s.model.length > 100) throw new Error('请填写有效的 DeepSeek 模型名称。');
  if (!s.url) return;
  const u = new URL(s.url);
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/')
    throw new Error('请输入服务器根地址，例如 https://astral.example.com');
  if (
    u.protocol !== 'https:' &&
    !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))
  )
    throw new Error('公网服务器请使用 HTTPS；本地调试可使用 http://localhost。');
}
// 同步配置与设备密钥分库存储，避免整份 Settings 被写入同步请求。
export function syncSettings(s: Settings) {
  return {
    url: s.url,
    token: s.remember ? s.token : '',
    autoSync: s.autoSync,
    remember: s.remember,
  };
}
export function persistSettings(s: Settings) {
  validateSettings(s);
  localStorage.setItem('astral.settings', JSON.stringify(syncSettings(s)));
  localStorage.setItem(
    s.aiScope ? `astral.ai:${s.aiScope}` : 'astral.ai',
    JSON.stringify({
      model: s.model,
      aiMode: s.aiMode,
      rememberKey: s.rememberKey,
      apiKey: s.rememberKey ? s.apiKey : '',
    }),
  );
  sessionStorage.setItem('astral.token', s.token);
  sessionStorage.setItem(s.aiScope ? `astral.apiKey:${s.aiScope}` : 'astral.apiKey', s.apiKey);
}
export function loadPlugins(scope = 'legacy'): Plugin[] {
  try {
    const raw = JSON.parse(localStorage.getItem(scopedStorageKey('plugins', scope)) || '[]');
    return Array.isArray(raw) ? raw.filter((p) => pluginSchema.safeParse(p).success) : [];
  } catch {
    return [];
  }
}
export async function api<T>(
  s: Settings,
  path: string,
  body?: unknown,
  method?: string,
  publicRequest = false,
  options?: { signal?: AbortSignal; timeout?: number; fresh?: boolean },
): Promise<T> {
  const authorization = s.sessionToken || s.token;
  if (!authorization && !publicRequest) throw new Error('请先登录账号或配置管理员设备令牌。');
  validateSettings(s);
  const verb = method || (body ? 'POST' : 'GET');
  const mutation = verb !== 'GET';
  const prefix = path.startsWith('/relay/')
    ? '/relay/'
    : path.startsWith('/pi/')
      ? '/pi/'
      : path.startsWith('/goals')
        ? '/goals'
        : path.startsWith('/learning/')
          ? '/learning/'
          : null;
  const invalidate = () => {
    if (prefix === '/relay/') {
      const p = body as
        { deviceId?: string; projectId?: string; operation?: { kind?: string } } | undefined;
      if (path === '/relay/operations') {
        if (p?.operation && ['write', 'restore', 'mkdir'].includes(p.operation.kind || ''))
          invalidateAPI(s, '/relay/files/' + p.deviceId + '/' + p.projectId + '/');
      } else if (path.startsWith('/relay/projects')) invalidateAPI(s, '/relay/projects');
      else if (
        path.startsWith('/relay/jobs') ||
        path === '/relay/submissions' ||
        path.startsWith('/relay/conversations')
      ) {
        invalidateAPI(s, '/relay/jobs');
        invalidateAPI(s, '/relay/conversations');
      } else if (path.startsWith('/relay/terminals')) invalidateAPI(s, '/relay/terminals');
      else invalidateAPI(s, '/relay/');
      return;
    }
    if (prefix === '/learning/') {
      if (path === '/learning/settings') invalidateAPI(s, '/learning/settings', true);
      invalidateAPI(s, '/learning/lessons', true);
      invalidateAPI(s, '/learning/wrong');
      const p = body as { id?: unknown; lessonId?: unknown } | undefined;
      const id = path === '/learning/lessons' ? p?.id : p?.lessonId;
      if (typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id))
        invalidateAPI(s, '/learning/lessons/' + id, true);
    } else if (prefix) invalidateAPI(s, prefix);
  };
  if (mutation && !publicRequest && prefix) invalidate();
  const load = async (): Promise<T> => {
    const deadline = AbortSignal.timeout(
      options?.timeout || (path === '/pi/message' ? 210000 : 100000),
    );
    const signal = options?.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    const checkAbort = () => {
      if (options?.signal?.aborted) throw new DOMException('已取消读取。', 'AbortError');
      if (deadline.aborted) throw new Error('请求超时，请重试。后台任务不会因此重新执行。');
    };
    let r: Response;
    try {
      r = await fetch(`${s.url.replace(/\/$/, '')}/api${path}`, {
        method: method || (body ? 'POST' : 'GET'),
        headers: {
          ...(!publicRequest && authorization ? { Authorization: `Bearer ${authorization}` } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal,
        redirect: 'error',
      });
    } catch (e) {
      checkAbort();
      throw new Error('无法连接服务器，请检查地址、网络与服务器允许的设备来源。');
    }
    let data;
    try {
      data = await r.json();
    } catch {
      checkAbort();
      throw new Error('服务器响应格式不正确，请检查服务器地址。');
    }
    if (!r.ok) {
      if (r.status === 401) clearResourceCaches();
      throw Object.assign(new Error(data.error || '请求失败'), { status: r.status });
    }
    return data;
  };
  const ttl = !publicRequest && !options?.signal && verb === 'GET' ? cacheTTL(path) : 0;
  try {
    if (!ttl) return await load();
    await warmResourceCache(s);
    return await resourceCache.read(resourceKey(s, path), load, { ttl, force: options?.fresh });
  } finally {
    if (mutation && !publicRequest && prefix) invalidate();
    if (mutation && !publicRequest && (path.startsWith('/social/') || path.startsWith('/mail/'))) {
      invalidateAPI(s, path.startsWith('/social/') ? '/social/unread' : '/mail/unread');
      if (typeof window !== 'undefined') window.dispatchEvent(new Event('astral:unread-change'));
    }
  }
}

export function localDraw(question: string, spread: Spread): Reading {
  return drawReading(question, spread) as Reading;
}
export function mergeEntries(local: Entry[], remote: Entry[]) {
  const map = new Map(local.map((e) => [e.id, e]));
  for (const e of remote) {
    const old = map.get(e.id);
    map.set(e.id, old?.deleted ? old : e);
  }
  return [...map.values()];
}
export function dateLabel(s: string) {
  return new Date(s).toLocaleString('zh-CN', {
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
