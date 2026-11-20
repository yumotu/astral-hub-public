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
            ? '消息已交给原发送流程，请核对对话记录。'
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
  return {
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
}
