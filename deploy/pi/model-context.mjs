import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const fail = (status, message) => Object.assign(new Error(message), { status });
const positive = (value) => Number.isSafeInteger(value) && value > 0 && value <= 100000000;
export function configureContext(template, state) {
  const result = structuredClone(template);
  result.contextWindow = state.contextWindow;
  result.maxTokens = Math.min(
    template.maxTokens || 131072,
    state.maxOutputTokens || template.maxTokens || 131072,
    Math.max(1, Math.floor(state.contextWindow / 4)),
  );
  if (state.inputModalities?.length) result.input = state.inputModalities;
  return result;
}
export function contextCompaction(window, settings = {}, outputBudget = 0) {
  return {
    ...settings,
    enabled: settings.enabled ?? true,
    reserveTokens: Math.min(Math.max(settings.reserveTokens || 10000, outputBudget), Math.floor(window / 4)),
    keepRecentTokens: Math.min(settings.keepRecentTokens || 4000, Math.floor(window / 8)),
  };
}
async function atomicJSON(file, value) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  await rename(temporary, file);
}
function metadata(raw, model) {
  if (raw?.id !== model || !positive(raw.context_window)) return null;
  return {
    model,
    maxContextWindow: raw.context_window,
    maxOutputTokens: positive(raw.max_output_tokens) ? raw.max_output_tokens : null,
    inputModalities: Array.isArray(raw.input_modalities)
      ? raw.input_modalities.filter((v) => v === 'text' || v === 'image')
      : [],
  };
}

// A capacity is authoritative only when returned by this exact provider/model.
// A cached capacity remains labelled as cached; missing fields never imply 1M.
export function createModelContext({
  root,
  model,
  apiKey,
  fetchImpl = fetch,
  baseUrl = 'https://api.deepseek.com/v1',
  now = Date.now,
  ttl = 300000,
}) {
  let known = null,
    lastCheck = null,
    inFlight = null,
    source = 'unavailable',
    warning = '';
  const cache = join(root, 'model-capabilities.json');
  const initialized = (async () => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    try {
      const saved = JSON.parse(await readFile(cache, 'utf8'));
      if (
        saved.baseUrl === baseUrl &&
        saved.model === model &&
        positive(saved.maxContextWindow) &&
        typeof saved.fetchedAt === 'string'
      )
        known = saved;
    } catch (e) {
      if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e;
    }
  })();
  async function discover(refresh = false) {
    await initialized;
    if (inFlight) return inFlight;
    if (!refresh && lastCheck !== null && now() - lastCheck < ttl) return;
    inFlight = (async () => {
      try {
        const response = await fetchImpl(baseUrl.replace(/\/$/, '') + '/models', {
          headers: { Authorization: 'Bearer ' + apiKey },
          signal: AbortSignal.timeout(12000),
          redirect: 'error',
        });
        if (!response.ok) throw new Error('provider unavailable');
        const bytes = await response.text();
        if (bytes.length > 262144) throw new Error('model list too large');
        const data = JSON.parse(bytes),
          selected = data.data?.find((v) => v.id === model);
        const value = metadata(selected, model);
        if (!value) throw new Error('missing context metadata');
        const fresh = { ...value, baseUrl, fetchedAt: new Date(now()).toISOString() };
        await atomicJSON(cache, fresh);
        known = fresh;
        source = 'api';
        warning = '';
      } catch {
        source = known ? 'cache' : 'unavailable';
        warning = known
          ? '模型 API 暂未返回有效上限，沿用上次确认的缓存。'
          : '未能从模型 API 确认上下文上限，暂用 64K 保守窗口；确认后可调整。';
      } finally {
        lastCheck = now();
        inFlight = null;
      }
    })();
    return inFlight;
  }
  function settingsFile(sessionKey) {
    if (!/^[a-f0-9]{64}$/.test(sessionKey || '')) throw fail(400, '对话编号不正确。');
    return join(root, 'sessions', sessionKey, 'context-settings.json');
  }
  async function get(sessionKey, options = {}) {
    const file = settingsFile(sessionKey);
    await discover(options.refresh);
    let requestedContextWindow = null;
    try {
      const value = JSON.parse(await readFile(file, 'utf8'));
      if (positive(value.contextWindow)) requestedContextWindow = value.contextWindow;
    } catch (e) {
      if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e;
    }
    const maxContextWindow = known?.maxContextWindow || null;
    return {
      model,
      source,
      warning,
      fetchedAt: known?.fetchedAt || null,
      maxContextWindow,
      minContextWindow: Math.min(16384, maxContextWindow || 16384),
      requestedContextWindow,
      contextWindow: maxContextWindow
        ? Math.min(requestedContextWindow || maxContextWindow, maxContextWindow)
        : 64000,
      maxOutputTokens: known?.maxOutputTokens || null,
      inputModalities: known?.inputModalities || [],
    };
  }
  return {
    get,
    async set(sessionKey, contextWindow) {
      const state = await get(sessionKey);
      if (
        contextWindow !== null &&
        (!positive(contextWindow) || contextWindow < state.minContextWindow)
      )
        throw fail(400, '上下文大小必须为有效的整数 Token。');
      if (!state.maxContextWindow) throw fail(503, '请先从模型 API 确认上下文上限。');
      if (contextWindow > state.maxContextWindow)
        throw fail(400, '上下文大小超过模型 API 返回的上限。');
      const folder = join(root, 'sessions', sessionKey);
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await atomicJSON(settingsFile(sessionKey), { contextWindow });
      return get(sessionKey);
    },
  };
}
