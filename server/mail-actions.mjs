import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fail } from './accounts.mjs';

import { mailOperationSchema, mailActionTitles } from '../shared/mail-actions.mjs';
export { mailOperationSchema, mailActionTitles };

export function createMailActions({
  db,
  withAccount,
  revision,
  encrypt,
  decrypt,
  invalidate,
  now = Date.now,
}) {
  db.exec(`CREATE TABLE IF NOT EXISTS mail_actions(
    owner TEXT NOT NULL,id TEXT NOT NULL,revision TEXT NOT NULL,payload TEXT NOT NULL,
    state TEXT NOT NULL,expires_at INTEGER NOT NULL,result TEXT,error TEXT,
    PRIMARY KEY(owner,id));
    UPDATE mail_actions SET state='unknown',error='服务重启，操作结果待核对；请先检查邮箱，不要重复执行。' WHERE state='running';`);
  const writes = new Map();
  const box = (list, name) =>
    list.find(
      (b) =>
        b.path === name || (b.path.toUpperCase() === 'INBOX' && name.toUpperCase() === 'INBOX'),
    );
  const isTrash = (b) =>
    b &&
    (b.specialUse === '\\Trash' ||
      /^(trash|deleted messages|deleted|已删除|垃圾箱|回收站)$/i.test(b.name || b.path) ||
      b.path === '[Gmail]/Trash');
  const isProtected = (b) =>
    b &&
    (b.specialUse ||
      b.path.toUpperCase() === 'INBOX' ||
      /^(inbox|sent|drafts|trash|junk|spam|deleted messages)$/i.test(b.name || b.path));
  function record(owner, id) {
    const r = db
      .prepare('SELECT * FROM mail_actions WHERE owner=? AND id=?')
      .get(owner, z.string().uuid().parse(id));
    if (!r) throw fail(404, '邮件操作不存在。');
    return r;
  }
  function inspect(owner, id) {
    const r = record(owner, id);
    if (r.state === 'prepared' && r.expires_at <= now()) {
      r.state = 'error';
      r.error = '操作预览已过期，未执行。';
      db.prepare(
        "UPDATE mail_actions SET state='error',error=? WHERE owner=? AND id=? AND state='prepared'",
      ).run(r.error, owner, id);
    }
    return {
      ...JSON.parse(decrypt(r.payload)).preview,
      state: r.state,
      ...(r.result ? { result: JSON.parse(r.result) } : {}),
      ...(r.error ? { error: r.error } : {}),
    };
  }
  async function exactMessages(client, operation, validity) {
    const actual = client.mailbox?.uidValidity;
    if (actual == null || (validity !== undefined && String(actual) !== validity))
      throw fail(409, '邮箱 UIDVALIDITY 已变化或不可用，请重新选择并预览邮件。');
    const rows = await client.fetchAll(
      operation.uids,
      { uid: true, envelope: true, flags: true },
      { uid: true },
    );
    const byUid = new Map(rows.filter(Boolean).map((m) => [m.uid, m]));
    if (operation.uids.some((id) => !byUid.has(id)))
      throw fail(409, '部分邮件已被移动或删除，请刷新后重新选择。');
    return {
      validity: String(actual),
      messages: operation.uids.map((uid) => ({
        uid,
        subject: String(byUid.get(uid).envelope?.subject || '(无主题)').slice(0, 300),
        from: String(byUid.get(uid).envelope?.from?.[0]?.address || '').slice(0, 254),
      })),
    };
  }
  function validateBoxes(list, operation) {
    if (operation.action === 'create-folder') {
      if (box(list, operation.name)) throw fail(409, '同名文件夹已存在。');
      return operation;
    }
    const source = box(list, operation.mailbox);
    if (!source) throw fail(404, '邮件文件夹不存在，请刷新。');
    if (operation.action === 'organize') {
      for (const group of operation.groups) {
        if (group.destination === source.path) throw fail(400, '分类目标不能是来源文件夹。');
        const target = box(list, group.destination);
        if (target?.path === source.path) throw fail(400, '分类目标不能是来源文件夹。');
        if (target && group.create) throw fail(409, '计划新建的文件夹已存在，请重新预览。');
        if (!target && !group.create) throw fail(404, '分类目标不存在，请显式选择新建文件夹。');
        if (target && (isTrash(target) || target.specialUse === '\\Junk'))
          throw fail(400, '分类整理不能移入回收站或垃圾邮件，请使用专门操作。');
      }
      return operation;
    }
    if (operation.action === 'rename-folder') {
      if (
        isProtected(source) ||
        list.some((b) => b.path.startsWith(source.path + (b.delimiter || '/')) && isProtected(b))
      )
        throw fail(403, '收件箱和邮箱系统文件夹不能重命名。');
      if (box(list, operation.name)) throw fail(409, '同名文件夹已存在。');
      if (operation.name.startsWith(source.path + (source.delimiter || '/')))
        throw fail(400, '不能将文件夹移入自身。');
    }
    if (operation.action === 'trash') {
      if (isTrash(source)) throw fail(409, '邮件已经在回收站中；此入口不永久删除邮件。');
      const trash = list.find(isTrash);
      if (!trash) throw fail(409, '邮箱未提供可识别的回收站，请选择已有文件夹进行移动。');
      operation = { ...operation, destination: trash.path };
    }
    if (operation.action === 'restore' && !isTrash(source))
      throw fail(409, '恢复操作仅用于回收站中的邮件。');
    if (operation.destination) {
      const destination = box(list, operation.destination);
      if (!destination) throw fail(404, '目标文件夹不存在。');
      if (destination.path === source.path) throw fail(400, '目标文件夹与来源相同。');
      if (operation.action === 'restore' && isTrash(destination))
        throw fail(400, '恢复目标不能是回收站。');
    }
    return operation;
  }
  async function prepare(owner, input, { id = randomUUID() } = {}) {
    const operation = mailOperationSchema.parse(input);
    const stamp = revision(owner);
    if (db.prepare('SELECT 1 FROM mail_actions WHERE owner=? AND id=?').get(owner, id))
      throw fail(409, '邮件操作编号已存在，请查询原操作状态。');
    const details = await withAccount(owner, async (client) => {
      const resolved = validateBoxes(await client.list(), operation);
      if (!resolved.mailbox) return { operation: resolved };
      const lock = await client.getMailboxLock(resolved.mailbox, { readOnly: true });
      try {
        if (!resolved.uids && resolved.action !== 'organize') {
          if (client.mailbox?.uidValidity == null)
            throw fail(409, '邮箱未提供 UIDVALIDITY，不能安全重命名。');
          return { operation: resolved, validity: String(client.mailbox.uidValidity) };
        }
        const exact =
          resolved.action === 'organize'
            ? { ...resolved, uids: resolved.groups.flatMap((g) => g.uids) }
            : resolved;
        return { operation: resolved, ...(await exactMessages(client, exact)) };
      } finally {
        lock.release();
      }
    });
    if (revision(owner) !== stamp) throw fail(409, '邮箱账号已经改变，请重新预览。');
    const preview = {
      id,
      action: operation.action,
      title: mailActionTitles[operation.action],
      mailbox: operation.mailbox || null,
      destination: details.operation.destination || operation.name || null,
      messages: details.messages || [],
      ...(operation.action === 'organize' ? { groups: operation.groups } : {}),
      expiresAt: new Date(now() + 10 * 60000).toISOString(),
    };
    db.prepare("DELETE FROM mail_actions WHERE owner=? AND expires_at<? AND state<>'running'").run(
      owner,
      now() - 7 * 86400000,
    );
    db.prepare(
      'INSERT INTO mail_actions(owner,id,revision,payload,state,expires_at) VALUES(?,?,?,?,?,?)',
    ).run(
      owner,
      id,
      stamp,
      encrypt(JSON.stringify({ ...details, preview })),
      'prepared',
      now() + 10 * 60000,
    );
    return { ...preview, state: 'prepared' };
  }
  function deny(owner, id) {
    const r = record(owner, id);
    if (r.state === 'prepared')
      db.prepare(
        "UPDATE mail_actions SET state='denied' WHERE owner=? AND id=? AND state='prepared'",
      ).run(owner, id);
    return inspect(owner, id);
  }
  async function confirm(owner, id, { isActive = () => true } = {}) {
    const r = record(owner, id);
    if (r.state === 'done') return inspect(owner, id);
    if (r.state !== 'prepared') throw fail(409, '此操作已经处理或结果待核对，不会再次执行。');
    if (r.expires_at <= now() || revision(owner) !== r.revision)
      throw fail(409, '操作预览已过期或邮箱账号已改变，请重新预览。');
    if (
      !db
        .prepare(
          "UPDATE mail_actions SET state='running' WHERE owner=? AND id=? AND state='prepared'",
        )
        .run(owner, id).changes
    )
      throw fail(409, '其他设备已提交此操作。');
    const previous = writes.get(owner) || Promise.resolve();
    const work = previous
      .catch(() => {})
      .then(async () => {
        let started = false;
        let progress;
        const saveProgress = () =>
          db
            .prepare('UPDATE mail_actions SET result=? WHERE owner=? AND id=?')
            .run(JSON.stringify(progress), owner, id);
        try {
          const { operation, validity } = JSON.parse(decrypt(r.payload));
          await withAccount(owner, async (client) => {
            if (!isActive()) throw fail(409, '任务已经取消，邮件操作未执行。');
            if (r.expires_at <= now() || revision(owner) !== r.revision)
              throw fail(409, '预览已过期或邮箱账号已改变。');
            // Recheck the live folders and message identities immediately before the mutation.
            const resolved = validateBoxes(await client.list(), operation);
            if (resolved.destination !== operation.destination)
              throw fail(409, '回收站或目标已改变，请重新预览。');
            let lock;
            try {
              if (operation.mailbox) {
                lock = await client.getMailboxLock(operation.mailbox);
                if (operation.action === 'organize')
                  await exactMessages(
                    client,
                    { ...operation, uids: operation.groups.flatMap((g) => g.uids) },
                    validity,
                  );
                else if (operation.uids) await exactMessages(client, operation, validity);
                else if (String(client.mailbox?.uidValidity) !== validity)
                  throw fail(409, '文件夹身份已改变，请重新预览。');
              }
              if (!isActive()) throw fail(409, '任务已经取消，邮件操作未执行。');
              if (revision(owner) !== r.revision) throw fail(409, '邮箱账号已经改变。');
              invalidate(owner, operation);
              started = true;
              let result;
              if (operation.action === 'organize') {
                progress = {
                  count: 0,
                  groups: operation.groups.map((g) => ({
                    destination: g.destination,
                    count: g.uids.length,
                    state: 'pending',
                    folderCreated: false,
                  })),
                };
                saveProgress();
                for (const [index, group] of operation.groups.entries()) {
                  if (!isActive() || revision(owner) !== r.revision)
                    throw fail(409, '任务或邮箱账号已改变，剩余分类未执行。');
                  const current = progress.groups[index];
                  await exactMessages(client, { uids: group.uids }, validity);
                  current.state = 'running';
                  saveProgress();
                  if (group.create) {
                    const created = await client.mailboxCreate(group.destination);
                    if (!created) throw fail(502, '邮箱未确认文件夹创建结果。');
                    current.folderCreated = true;
                    saveProgress();
                  }
                  if (!isActive() || revision(owner) !== r.revision)
                    throw fail(409, '任务或邮箱账号已改变，剩余分类未执行。');
                  result = await client.messageMove(group.uids, group.destination, { uid: true });
                  if (!result) throw fail(502, '邮箱未确认分类移动结果。');
                  current.state = 'done';
                  progress.count += group.uids.length;
                  saveProgress();
                }
              } else if (operation.action === 'read')
                result = await client.messageFlagsAdd(operation.uids, ['\\Seen'], { uid: true });
              else if (operation.action === 'unread')
                result = await client.messageFlagsRemove(operation.uids, ['\\Seen'], { uid: true });
              else if (operation.action === 'create-folder')
                result = await client.mailboxCreate(operation.name);
              else if (operation.action === 'rename-folder')
                result = await client.mailboxRename(operation.mailbox, operation.name);
              else
                result = await client.messageMove(operation.uids, operation.destination, {
                  uid: true,
                });
              if (!result) throw fail(502, '邮箱未确认操作结果，请先核对邮箱。');
            } finally {
              lock?.release();
            }
          });
          db.prepare("UPDATE mail_actions SET state='done',result=? WHERE owner=? AND id=?").run(
            JSON.stringify({
              ...progress,
              count: JSON.parse(decrypt(r.payload)).preview.messages.length,
              finishedAt: new Date(now()).toISOString(),
            }),
            owner,
            id,
          );
        } catch (error) {
          if (progress) {
            for (const group of progress.groups)
              if (group.state === 'running') group.state = 'unknown';
            saveProgress();
          }
          const message = started
            ? '邮箱返回中断，操作结果待核对；请先刷新邮箱，不要重复执行。'
            : String(error.message || '邮箱操作未执行。');
          db.prepare('UPDATE mail_actions SET state=?,error=? WHERE owner=? AND id=?').run(
            started ? 'unknown' : 'error',
            message,
            owner,
            id,
          );
          throw fail(started ? 502 : error.status || 502, message);
        } finally {
          invalidate(owner, JSON.parse(decrypt(r.payload)).operation);
        }
        return inspect(owner, id);
      });
    writes.set(owner, work);
    try {
      return await work;
    } finally {
      if (writes.get(owner) === work) writes.delete(owner);
    }
  }
  return { prepare, inspect, confirm, deny };
}
