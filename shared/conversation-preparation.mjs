import { z } from 'zod';
import { DSH_PROMPT_TEXT_LIMIT } from './dsh-prompt.mjs';
export const preparationTextLimit = (origin) =>
  origin === 'remote' ? DSH_PROMPT_TEXT_LIMIT : 8000;
const target = z
  .object({
    origin: z.enum(['server', 'computer', 'remote']),
    projectId: z.string().nullable(),
    deviceId: z.string().optional(),
    connectionId: z.string().optional(),
    label: z.string().optional(),
    locationName: z.string().optional(),
    location: z.enum(['server', 'computer']).optional(),
    hostId: z.string().optional(),
    projectName: z.string().optional(),
  })
  .strip();
const native = z
  .object({ origin: z.enum(['server', 'computer', 'remote']), nativeId: z.string().uuid() })
  .strip();
const entry = z
  .object({
    id: z.string().uuid(),
    target,
    draft: z.string().max(DSH_PROMPT_TEXT_LIMIT),
    createdAt: z.string(),
    state: z.enum(['creating', 'ready', 'unknown', 'failed', 'handed']),
    error: z.string(),
    native: native.optional(),
    resumeRequired: z.boolean().optional(),
    message: z
      .object({ id: z.string().uuid(), text: z.string().min(1).max(DSH_PROMPT_TEXT_LIMIT) })
      .optional(),
  })
  .strict();
let database;
function serializedPreparationWrite(work) {
  if (typeof indexedDB === 'undefined')
    return Promise.reject(Error('本地草稿存储不可用，请保留当前内容。'));
  database ||= new Promise((resolve, reject) => {
    const request = indexedDB.open('astral-conversation-preparations-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('writes');
    request.onerror = () => {
      database = undefined;
      reject(request.error);
    };
    request.onblocked = () => {
      database = undefined;
      reject(Error('本地草稿存储正在升级，请关闭其他页面后重试。'));
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        database = undefined;
      };
      resolve(db);
    };
  });
  return database.then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction('writes', 'readwrite');
        let result, failure;
        transaction.oncomplete = () => resolve(result);
        transaction.onabort = transaction.onerror = () =>
          reject(failure || transaction.error || Error('本地草稿保存失败。'));
        // The request callback runs only after earlier readwrite transactions release
        // this store. Do not await anything while holding the cross-tab mutex.
        const request = transaction.objectStore('writes').get('mutex');
        request.onsuccess = () => {
          try {
            result = work();
          } catch (e) {
            failure = e;
            transaction.abort();
          }
        };
      }),
  );
}
/** Local intent only. A restored entry never resumes a create/send by itself. */
export function createConversationPreparationJournal(storage, scope) {
  const key = scope + ':preparations';
  let entries = [];
  try {
    const parsed = z
      .array(entry)
      .max(40)
      .safeParse(JSON.parse(storage.getItem(key) || '[]'));
    if (parsed.success)
      entries = parsed.data.map((v) => ({
        ...v,
        resumeRequired: true,
        state: v.state === 'handed' ? 'handed' : 'unknown',
        error:
          v.state === 'handed'
            ? '发送交接尚未确认，请核对对话记录；不会自动重复发送。'
            : '正在核对上次创建结果，草稿已保留。',
      }));
  } catch {}
  function save(next) {
    storage.setItem(key, JSON.stringify(next));
    entries = next;
  }
  const find = (id) => entries.find((v) => v.id === id);
  function patch(id, value) {
    const current = find(id);
    if (!current) throw Error('准备中的对话不存在。');
    const next = entry.parse({ ...current, ...value });
    save(entries.map((v) => (v.id === id ? next : v)));
    return next;
  }
  const methods = {
    list: () => entries,
    begin(id, value) {
      const old = find(id);
      if (old) return old;
      if (entries.length >= 40) throw Error('准备中的对话较多，请先处理保留的草稿。');
      const item = entry.parse({
        id,
        target: value,
        draft: '',
        state: 'creating',
        error: '',
        createdAt: new Date().toISOString(),
      });
      save([...entries, item]);
      return item;
    },
    draft(id, draft) {
      const current = find(id);
      if (!current) throw Error('准备中的对话不存在。');
      const next = entry.parse({ ...current, draft });
      try {
        save(entries.map((v) => (v.id === id ? next : v)));
      } catch (e) {
        entries = entries.map((v) => (v.id === id ? next : v));
        throw e;
      }
      return next;
    },
    queue(id, text, requestId = crypto.randomUUID()) {
      const current = find(id);
      if (current?.message) throw Error('首条消息正在等待连接，可先编辑其他补充。');
      const limit = preparationTextLimit(current?.target.origin);
      if (!text.trim() || text.trim().length > limit)
        throw Error(`请填写消息，单条最多 ${limit} 个字符。`);
      return patch(id, {
        message: { id: requestId, text: text.trim() },
        draft: '',
        resumeRequired: false,
      });
    },
    edit(id) {
      const v = find(id);
      if (!v) return;
      const draft = (v.message?.text || '') + (v.draft ? '\n\n' + v.draft : '');
      if (draft.length > preparationTextLimit(v.target.origin))
        throw Error('待发送消息和补充内容合并后太长，请先缩短补充内容再编辑。');
      return patch(id, { draft, message: undefined });
    },
    creating: (id) => patch(id, { state: 'creating', error: '', resumeRequired: false }),
    resume: (id) => patch(id, { resumeRequired: false, error: '' }),
    resolve(id, value) {
      if (find(id)?.state === 'handed') return find(id);
      return patch(id, { state: 'ready', native: native.parse(value), error: '' });
    },
    fail: (id, error, known = false) => patch(id, { state: known ? 'failed' : 'unknown', error }),
    claim(id) {
      const v = find(id);
      if (!v || v.state !== 'ready' || !v.native || v.resumeRequired) return null;
      // Commit the claim before handing intent to the existing idempotent outbox.
      try {
        patch(id, { state: 'handed' });
      } catch (e) {
        // Saving may be unavailable, but the visible recovery state must still
        // change. A reopen also requires explicit continuation by definition.
        entries = entries.map((item) =>
          item.id === id
            ? {
                ...item,
                resumeRequired: true,
                error: '本地保存失败，消息尚未发送。内容已保留，请重试继续或放弃本地草稿。',
              }
            : item,
        );
        throw e;
      }
      return v;
    },
    remove: (id) => save(entries.filter((v) => v.id !== id)),
  };
  const text = (value) => JSON.stringify([value?.draft, value?.message]);
  let baseline = new Map();
  try {
    baseline = new Map(
      z
        .array(entry)
        .max(40)
        .parse(JSON.parse(storage.getItem(key) || '[]'))
        .map((value) => [value.id, value]),
    );
  } catch {}
  let pending = Promise.resolve();
  return /** @type {Record<string, (...args: any[]) => any>} */ (
    Object.fromEntries(
      Object.entries(methods).map(([name, method]) => {
        if (name === 'list') return [name, method];
        /** @param {...any} args */
        const write = (...args) => {
          const run = pending.then(async () => {
            const local = find(args[0]);
            const unsaved = entries.filter(
              (value) => value.id !== args[0] && text(value) !== text(baseline.get(value.id)),
            );
            try {
              return await serializedPreparationWrite(() => {
                const fresh = z
                  .array(entry)
                  .max(40)
                  .parse(JSON.parse(storage.getItem(key) || '[]'));
                const current = fresh.find((value) => value.id === args[0]);
                if (name !== 'begin' && name !== 'remove' && name !== 'claim' && !current)
                  throw Error('本地草稿已在其他页面移除；当前输入仍保留，请先复制内容。');
                if (
                  current &&
                  !['begin', 'resolve', 'fail'].includes(name) &&
                  text(current) !== text(baseline.get(args[0]))
                )
                  throw Error(
                    '此草稿已在其他页面修改，未覆盖其内容；请保留当前输入后重新打开核对。',
                  );
                if (
                  local &&
                  !['draft', 'remove', 'begin'].includes(name) &&
                  text(local) !== text(baseline.get(args[0]))
                )
                  throw Error('当前输入尚未保存，请先复制内容或重新保存草稿。');
                const retained = entries.filter(
                  (value) => value.id !== args[0] && text(value) !== text(baseline.get(value.id)),
                );
                const confirmationRequired = new Set(
                  entries.filter((value) => value.resumeRequired).map((value) => value.id),
                );
                entries = fresh.map((value) =>
                  confirmationRequired.has(value.id) ? { ...value, resumeRequired: true } : value,
                );
                const result =
                  current?.state === 'handed' &&
                  ['creating', 'resume', 'resolve', 'fail'].includes(name)
                    ? current
                    : method(...args);
                const previous = baseline;
                baseline = new Map(entries.map((value) => [value.id, value]));
                for (const value of retained) {
                  if (previous.has(value.id)) baseline.set(value.id, previous.get(value.id));
                  else baseline.delete(value.id);
                  entries = entries.filter((item) => item.id !== value.id).concat(value);
                }
                return result;
              });
            } catch (e) {
              for (const value of unsaved)
                entries = entries.filter((item) => item.id !== value.id).concat(value);
              if (local && name === 'draft') {
                const retained = entry.parse({
                  ...local,
                  draft: args[1],
                  resumeRequired: true,
                  error: e.message,
                });
                entries = entries.some((value) => value.id === local.id)
                  ? entries.map((value) => (value.id === local.id ? retained : value))
                  : [...entries, retained];
              } else if (local && name === 'claim') {
                entries = entries.map((value) =>
                  value.id === local.id
                    ? {
                        ...value,
                        resumeRequired: true,
                        error: '本地保存失败，消息尚未发送。内容已保留，请重试继续或放弃本地草稿。',
                      }
                    : value,
                );
              }
              throw e;
            }
          });
          pending = run.catch(() => {});
          return run;
        };
        return [name, write];
      }),
    )
  );
}
