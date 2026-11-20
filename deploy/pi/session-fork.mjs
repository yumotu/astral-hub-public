import { readFile, writeFile, rename, mkdir, readdir, lstat, rm, realpath } from 'node:fs/promises';
import { join, resolve, dirname, sep, basename } from 'node:path';

const fail = (status, message) => Object.assign(new Error(message), { status });
const key = (value) => /^[a-f0-9]{64}$/.test(value || '');
const uuid = (value) => /^[a-f0-9-]{36}$/.test(value || '');
async function atomic(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + '.next';
  await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
  await rename(temp, path);
}
async function scopedFile(root, file) {
  const base = await realpath(root),
    actual = await realpath(file);
  if (!actual.startsWith(base + sep) || !actual.endsWith('.jsonl'))
    throw fail(409, '原生会话路径不正确。');
  const info = await lstat(actual);
  if (!info.isFile() || info.size > 256 * 1024 * 1024) throw fail(409, '原生会话过大或不可用。');
  return actual;
}
export async function sessionCheckpoint(SessionManager, root, requestId, state, phase) {
  if (!uuid(requestId) || !['before', 'after'].includes(phase))
    throw fail(400, '检查点格式不正确。');
  let leafId = null,
    file = state.sessionFile;
  if (file) {
    try {
      file = await scopedFile(root, file);
      leafId = SessionManager.open(file).getLeafId();
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  const path = join(root, 'checkpoints', requestId + '.json');
  let saved = {};
  try {
    saved = JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  await atomic(path, { ...saved, sessionFile: file || null, [phase]: { leafId } });
}

// Copies Pi's native tree path, including tool messages, thinking and compaction.
// The source session may still run: only a saved, immutable leaf is selected.
export async function forkNativeSession(SessionManager, sessionsRoot, p) {
  if (
    !key(p.sourceKey) ||
    !key(p.targetKey) ||
    p.sourceKey === p.targetKey ||
    !uuid(p.turnId) ||
    (p.checkpoints &&
      (!Array.isArray(p.checkpoints) ||
        p.checkpoints.length > 10000 ||
        p.checkpoints.some((c) => !uuid(c.from) || !uuid(c.to)))) ||
    !['before', 'after'].includes(p.position)
  )
    throw fail(400, '分支参数不正确。');
  const source = join(sessionsRoot, p.sourceKey),
    target = join(sessionsRoot, p.targetKey);
  const origin = { sourceKey: p.sourceKey, turnId: p.turnId, position: p.position };
  try {
    const prior = JSON.parse(await readFile(join(target, 'branch-origin.json'), 'utf8'));
    if (JSON.stringify(prior) !== JSON.stringify(origin))
      throw fail(409, '分支编号已用于其他位置。');
    return { native: true };
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  let saved;
  try {
    saved = JSON.parse(await readFile(join(source, 'checkpoints', p.turnId + '.json'), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  let session, leafId, sessionFile;
  if (saved) {
    if (!saved[p.position]) throw fail(409, '此步骤尚未完成，暂时只能编辑之前的消息。');
    leafId = saved[p.position].leafId;
    if (leafId) sessionFile = await scopedFile(source, saved.sessionFile);
  } else {
    // Legacy turns have no checkpoint. Only an unambiguous exact user message
    // match on the native active branch is eligible; never guess a timestamp.
    const names = (await readdir(source)).filter((name) => name.endsWith('.jsonl'));
    if (names.length !== 1) throw fail(409, '旧对话没有唯一原生会话，无法安全分支。');
    sessionFile = await scopedFile(source, join(source, names[0]));
    session = SessionManager.open(sessionFile);
    const branch = session.getBranch();
    const text = (entry) =>
      Array.isArray(entry.message?.content)
        ? entry.message.content
            .filter((c) => c.type === 'text')
            .map((c) => c.text)
            .join('\n')
        : entry.message?.content;
    const matches = branch.filter(
      (e) => e.type === 'message' && e.message.role === 'user' && text(e) === p.input,
    );
    if (matches.length !== 1) throw fail(409, '旧消息无法唯一对应原生上下文，请从新消息建立分支。');
    const index = branch.indexOf(matches[0]);
    const next = branch.findIndex(
      (e, i) => i > index && e.type === 'message' && e.message.role === 'user',
    );
    leafId =
      p.position === 'before'
        ? matches[0].parentId
        : branch[(next < 0 ? branch.length : next) - 1].id;
  }
  // Only a fresh destination can be written. A prior incomplete attempt is
  // rejected, retaining evidence instead of overwriting an unknown session.
  await mkdir(target, { mode: 0o700 });
  try {
    let snapshot = null;
    let entries = new Set();
    if (leafId) {
      session = SessionManager.open(sessionFile, target);
      snapshot = session.createBranchedSession(leafId);
      if (!snapshot || resolve(dirname(snapshot)) !== resolve(target))
        throw fail(500, '原生分支未写入目标目录。');
      await atomic(join(target, 'native-session.json'), { file: basename(snapshot) });
      entries = new Set(
        SessionManager.open(snapshot)
          .getBranch()
          .map((e) => e.id),
      );
    }
    // UI history has new IDs. Carry immutable leaf checkpoints under those IDs
    // so a later branch of an inherited message never falls back to text matching.
    for (const { from, to } of p.checkpoints || []) {
      let original;
      try {
        original = JSON.parse(await readFile(join(source, 'checkpoints', from + '.json'), 'utf8'));
      } catch (e) {
        if (e.code === 'ENOENT') continue;
        throw e;
      }
      const copy = { sessionFile: snapshot };
      for (const phase of ['before', 'after']) {
        const point = original[phase];
        if (point && (point.leafId === null || entries.has(point.leafId)))
          copy[phase] = { leafId: point.leafId };
      }
      if (copy.before || copy.after) await atomic(join(target, 'checkpoints', to + '.json'), copy);
    }
    await atomic(join(target, 'branch-origin.json'), origin);
  } catch (e) {
    await rm(target, { recursive: true, force: true });
    throw e;
  }
  return { native: true };
}
