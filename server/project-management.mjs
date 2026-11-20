import { Readable } from 'node:stream';
import { z } from 'zod';
import { fail } from './accounts.mjs';
import { conversationTargetSchema } from './unified-conversations.mjs';
import { createProjectLabels, projectLabelSchema } from './project-labels.mjs';

export const computerTargetSchema = z.discriminatedUnion('origin', [
  z.object({ origin: z.literal('computer'), deviceId: z.string().uuid() }).strict(),
  z.object({ origin: z.literal('remote'), connectionId: z.string().uuid() }).strict(),
]);
export const projectManagementChangeSchema = z
  .object({
    target: conversationTargetSchema,
    revision: z.number().int().positive(),
  })
  .strict();
export const computerManagementChangeSchema = z
  .object({
    target: computerTargetSchema,
    revision: z.number().int().positive(),
  })
  .strict();
export const projectManagementRenameSchema = z
  .object({
    target: conversationTargetSchema,
    name: projectLabelSchema.shape.name,
  })
  .strict();
const key = (target) =>
  JSON.stringify(
    target.origin === 'server'
      ? ['server', target.projectId]
      : target.origin === 'computer'
        ? ['computer', target.deviceId, target.projectId ?? null]
        : ['remote', target.connectionId, target.projectId ?? null],
  );
const bare = (value) =>
  conversationTargetSchema.parse(
    value.origin === 'server'
      ? { origin: 'server', projectId: value.projectId }
      : value.origin === 'computer'
        ? { origin: 'computer', deviceId: value.deviceId, projectId: value.projectId }
        : { origin: 'remote', connectionId: value.connectionId, projectId: value.projectId },
  );
const computerOf = (target) =>
  target.origin === 'computer'
    ? { origin: 'computer', deviceId: target.deviceId }
    : target.origin === 'remote'
      ? { origin: 'remote', connectionId: target.connectionId }
      : null;
const labelTarget = (target) =>
  target.origin === 'server'
    ? 'server'
    : target.origin === 'computer'
      ? target.deviceId
      : 'dsh:' + target.connectionId;

// Account metadata only: no paths are renamed and no histories are deleted.
export function createProjectManagement(db, { adapters, relay, dshRemote, now = Date.now }) {
  const labels = createProjectLabels(db),
    locks = new Set();
  db.exec(`CREATE TABLE IF NOT EXISTS assistant_project_management(
    owner TEXT NOT NULL,target_key TEXT NOT NULL,target TEXT NOT NULL,name TEXT NOT NULL,
    original_name TEXT NOT NULL,removed_at TEXT,revision INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY(owner,target_key));
    CREATE TABLE IF NOT EXISTS assistant_computer_management(
    owner TEXT NOT NULL,target_key TEXT NOT NULL,target TEXT NOT NULL,name TEXT NOT NULL,
    removed_at TEXT,revision INTEGER NOT NULL DEFAULT 1,source_revision INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(owner,target_key));`);
  const projectRow = (owner, target) =>
    db
      .prepare('SELECT * FROM assistant_project_management WHERE owner=? AND target_key=?')
      .get(owner, key(target));
  const computerRow = (owner, target) =>
    db
      .prepare('SELECT * FROM assistant_computer_management WHERE owner=? AND target_key=?')
      .get(owner, key(target));
  const projectView = (r) => ({
    target: JSON.parse(r.target),
    name: r.name,
    originalName: r.original_name,
    removedAt: r.removed_at,
    revision: r.revision,
  });
  const computerView = (r) => {
    const target = JSON.parse(r.target);
    const { hostId, ...identity } = target;
    return {
      target: identity,
      ...(hostId ? { hostId } : {}),
      name: r.name,
      removedAt: r.removed_at,
      revision: r.revision,
    };
  };
  const aliases = (owner, target, name) =>
    labels.decorate(owner, labelTarget(target), [{ id: target.projectId, name }])[0].name;
  function observe(actor, targets = []) {
    for (const value of targets) {
      let target;
      try {
        target = bare(value);
      } catch {
        continue;
      }
      if (target.projectId === null) continue;
      const prior = projectRow(actor.id, target),
        stored = prior && JSON.parse(prior.target);
      const enriched = { ...target };
      for (const field of ['location', 'hostId', 'locationName'])
        if (value[field] ?? stored?.[field]) enriched[field] = value[field] ?? stored[field];
      const original =
        value.originalName || value.projectName || prior?.original_name || target.projectId;
      const name = aliases(actor.id, target, original);
      if (!prior)
        db.prepare('INSERT INTO assistant_project_management VALUES(?,?,?,?,?,NULL,1)').run(
          actor.id,
          key(target),
          JSON.stringify(enriched),
          name,
          original,
        );
      else {
        const changed =
          prior.name !== name ||
          prior.original_name !== original ||
          ['location', 'hostId'].some((field) => stored[field] !== enriched[field]);
        db.prepare(
          `UPDATE assistant_project_management SET target=?,name=?,original_name=?,
          revision=revision+? WHERE owner=? AND target_key=?`,
        ).run(JSON.stringify(enriched), name, original, Number(changed), actor.id, key(target));
      }
    }
  }
  function observeComputer(actor, target, name, hostId, sourceRevision = 0, revoked = false) {
    const prior = computerRow(actor.id, target),
      enriched = { ...target, ...(hostId ? { hostId } : {}) };
    if (!prior)
      db.prepare('INSERT INTO assistant_computer_management VALUES(?,?,?,?,?,?,?)').run(
        actor.id,
        key(target),
        JSON.stringify(enriched),
        name,
        revoked ? new Date(now()).toISOString() : null,
        1,
        sourceRevision,
      );
    else {
      const changed =
        prior.name !== name ||
        prior.source_revision !== sourceRevision ||
        JSON.parse(prior.target).hostId !== hostId ||
        (!prior.removed_at && revoked);
      db.prepare(
        `UPDATE assistant_computer_management SET target=?,name=?,
        removed_at=CASE WHEN ? THEN COALESCE(removed_at,?) ELSE removed_at END,
        source_revision=?,revision=revision+? WHERE owner=? AND target_key=?`,
      ).run(
        JSON.stringify(enriched),
        name,
        Number(revoked),
        new Date(now()).toISOString(),
        sourceRevision,
        Number(changed),
        actor.id,
        key(target),
      );
    }
  }
  function refresh(actor) {
    observe(actor, [...adapters.deferredTargets(actor), ...adapters.cachedTargets(actor.id)]);
    for (const device of db
      .prepare('SELECT id,name,revoked FROM relay_devices WHERE owner=?')
      .all(actor.id)) {
      observeComputer(
        actor,
        { origin: 'computer', deviceId: device.id },
        device.name,
        device.id,
        0,
        !!device.revoked,
      );
      observe(
        actor,
        db
          .prepare('SELECT id,name FROM relay_projects WHERE device_id=?')
          .all(device.id)
          .map((p) => ({
            origin: 'computer',
            deviceId: device.id,
            projectId: p.id,
            projectName: p.name,
            location: 'computer',
            hostId: device.id,
            locationName: device.name,
          })),
      );
    }
    for (const c of dshRemote.managementConnections(actor.id)) {
      const savedHost = db
        .prepare(
          "SELECT runtime FROM agent_conversation_bindings WHERE owner=? AND origin='remote' AND json_extract(runtime,'$.connectionId')=? LIMIT 1",
        )
        .get(actor.id, c.id);
      const historicalHost = savedHost && JSON.parse(savedHost.runtime);
      const host =
        c.host ||
        (historicalHost && {
          location: historicalHost.location,
          deviceId: historicalHost.deviceId,
        });
      if (host?.location === 'server') continue;
      // A trusted device identity, never a display-name comparison, defines a host.
      if (
        host?.location === 'computer' ||
        computerRow(actor.id, { origin: 'remote', connectionId: c.id })
      )
        observeComputer(
          actor,
          { origin: 'remote', connectionId: c.id },
          c.host?.name || c.name,
          host?.deviceId ||
            JSON.parse(
              computerRow(actor.id, { origin: 'remote', connectionId: c.id })?.target || '{}',
            ).hostId,
          c.revision,
          !!c.revoked,
        );
    }
    for (const r of db
      .prepare('SELECT origin,runtime FROM agent_conversation_bindings WHERE owner=?')
      .all(actor.id)) {
      const runtime = JSON.parse(r.runtime);
      if (!runtime.projectId) continue;
      const target =
        runtime.transport === 'server'
          ? { origin: 'server', projectId: runtime.projectId }
          : runtime.transport === 'astral-relay'
            ? { origin: 'computer', deviceId: runtime.deviceId, projectId: runtime.projectId }
            : {
                origin: 'remote',
                connectionId: runtime.connectionId,
                projectId: runtime.projectId,
              };
      observe(actor, [{ ...target, location: runtime.location }]);
    }
    // A selected target can have been observed without populating the full
    // catalogue cache. Apply account aliases to those saved rows as well.
    observe(
      actor,
      db
        .prepare('SELECT target,original_name FROM assistant_project_management WHERE owner=?')
        .all(actor.id)
        .map((r) => ({ ...JSON.parse(r.target), originalName: r.original_name })),
    );
  }
  function list(actor) {
    refresh(actor);
    return {
      projects: db
        .prepare('SELECT * FROM assistant_project_management WHERE owner=? ORDER BY target_key')
        .all(actor.id)
        .map(projectView),
      computers: db
        .prepare('SELECT * FROM assistant_computer_management WHERE owner=? ORDER BY target_key')
        .all(actor.id)
        .map(computerView),
    };
  }
  function assertSelectable(actor, input) {
    const target = conversationTargetSchema.parse(input),
      parent = computerOf(target);
    if (
      projectRow(actor.id, target)?.removed_at ||
      (parent && computerRow(actor.id, parent)?.removed_at)
    )
      throw fail(409, '此项目或电脑已移除，请先恢复项目或重新连接电脑。');
  }
  function assertIdle(actor, target) {
    if (
      target.origin === 'remote' &&
      db
        .prepare(
          "SELECT 1 FROM dsh_conversations WHERE owner=? AND connection_id=? AND workspace_id=? AND state IN ('creating','unknown')",
        )
        .get(actor.id, target.connectionId, target.projectId)
    )
      throw fail(409, '项目有原生对话创建结果待核对，请稍后重试。');
    for (const n of adapters.nativeList(actor)) {
      const runtime = n.runtime;
      if (!runtime || runtime.projectId !== target.projectId || n.origin !== target.origin)
        continue;
      if (target.origin === 'computer' && runtime.deviceId !== target.deviceId) continue;
      if (target.origin === 'remote' && runtime.connectionId !== target.connectionId) continue;
      if (n.runState?.busy) throw fail(409, '项目仍有任务或操作等待处理，请结束后再移除。');
    }
    if (
      target.origin === 'computer' &&
      ['relay_jobs', 'relay_operations'].some((table) =>
        db
          .prepare(
            `SELECT 1 FROM ${table} WHERE owner=? AND device_id=? AND project_id=? AND status IN ('queued','running')`,
          )
          .get(actor.id, target.deviceId, target.projectId),
      )
    )
      throw fail(409, '项目仍有任务或文件操作，请结束后再移除。');
    if (
      db
        .prepare(
          "SELECT 1 FROM assistant_switches WHERE owner=? AND state!='done' AND json_extract(signature,'$.target.origin')=? AND json_extract(signature,'$.target.projectId')=? AND COALESCE(json_extract(signature,'$.target.deviceId'),json_extract(signature,'$.target.connectionId'),'')=?",
        )
        .get(
          actor.id,
          target.origin,
          target.projectId,
          target.deviceId || target.connectionId || '',
        )
    )
      throw fail(409, '项目有对话创建或切换结果待核对，请稍后重试。');
  }
  async function knownProject(actor, input) {
    const target = conversationTargetSchema.parse(input);
    if (!target.projectId) throw fail(400, '独立对话不是可移除的项目。');
    refresh(actor);
    if (!projectRow(actor.id, target)) {
      await adapters.available(actor, target);
      observe(actor, [target]);
    }
    return { target, row: projectRow(actor.id, target) };
  }
  const checkRevision = (r, revision) => {
    if (r.revision !== revision) throw fail(409, '项目或连接已变化，请刷新并重新确认。');
  };
  async function previewProject(actor, input, action = 'remove') {
    const { target, row } = await knownProject(actor, input);
    if (action === 'remove' && !row.removed_at) assertIdle(actor, target);
    return projectView(row);
  }
  async function rename(actor, input) {
    const p = projectManagementRenameSchema.parse(input),
      { target } = await knownProject(actor, p.target);
    labels.set(actor.id, labelTarget(target), target.projectId, p.name);
    // Refresh increments the revision and updates every subsequent metadata read.
    refresh(actor);
    return { project: projectView(projectRow(actor.id, target)) };
  }
  async function change(actor, input, remove) {
    const p = projectManagementChangeSchema.parse(input),
      { target } = await knownProject(actor, p.target);
    const r = projectRow(actor.id, target);
    checkRevision(r, p.revision);
    if (!!r.removed_at === remove) return { project: projectView(r) };
    if (remove) assertIdle(actor, target);
    else {
      const parent = computerOf(target);
      if (parent && computerRow(actor.id, parent)?.removed_at)
        throw fail(409, '请先重新连接电脑，再恢复项目。');
      await adapters.available(actor, target);
      refresh(actor);
      if (parent && computerRow(actor.id, parent)?.removed_at)
        throw fail(409, '请先重新连接电脑，再恢复项目。');
      checkRevision(projectRow(actor.id, target), p.revision);
    }
    db.exec('SAVEPOINT assistant_project_change');
    try {
      db.prepare(
        'UPDATE assistant_project_management SET removed_at=?,revision=revision+1 WHERE owner=? AND target_key=?',
      ).run(remove ? new Date(now()).toISOString() : null, actor.id, key(target));
      if (remove && target.origin === 'server')
        db.prepare(
          'UPDATE pi_preferences SET default_project_id=NULL WHERE owner=? AND default_project_id=?',
        ).run(actor.id, target.projectId);
      db.exec('RELEASE assistant_project_change');
    } catch (error) {
      db.exec('ROLLBACK TO assistant_project_change; RELEASE assistant_project_change');
      throw error;
    }
    return { project: projectView(projectRow(actor.id, target)) };
  }
  function previewComputer(actor, input) {
    const target = computerTargetSchema.parse(input);
    refresh(actor);
    if (
      target.origin === 'remote' &&
      dshRemote
        .managementConnections(actor.id)
        .some((c) => c.id === target.connectionId && c.host?.location === 'server')
    )
      throw fail(400, '服务器DSH连接不能作为电脑移除。');
    const row = computerRow(actor.id, target);
    if (!row) throw fail(404, '此电脑不存在，或属于其他账号；服务器DSH连接不能作为电脑移除。');
    return computerView(row);
  }
  async function removeComputer(actor, input) {
    const p = computerManagementChangeSchema.parse(input);
    previewComputer(actor, p.target);
    const r = computerRow(actor.id, p.target);
    checkRevision(r, p.revision);
    if (r.removed_at) return { computer: computerView(r) };
    const lock = actor.id + ':' + key(p.target);
    if (locks.has(lock)) throw fail(409, '电脑连接正在移除，请稍候核对结果。');
    locks.add(lock);
    try {
      const path =
        p.target.origin === 'computer'
          ? '/api/relay/devices/' + p.target.deviceId
          : '/api/agent/remote/connections/' + p.target.connectionId;
      const req = Readable.from([]);
      req.method = 'DELETE';
      req.headers = {};
      let code, response;
      const json = (s, data) => {
        code = s;
        response = data;
      };
      const handler = p.target.origin === 'computer' ? relay.after : dshRemote.handle;
      const handled = await handler.call(
        p.target.origin === 'computer' ? relay : dshRemote,
        req,
        new URL('http://internal' + path),
        json,
        actor,
      );
      if (!handled || code !== 200 || response?.ok !== true)
        throw fail(code || 502, '电脑撤销结果待核对，请刷新；不会重放任务。');
      refresh(actor);
      return { computer: computerView(computerRow(actor.id, p.target)) };
    } finally {
      locks.delete(lock);
    }
  }
  return {
    list,
    observe,
    rename,
    remove: (a, p) => change(a, p, true),
    restore: (a, p) => change(a, p, false),
    removeComputer,
    previewProject,
    previewComputer,
    assertSelectable,
    filterTargets: (actor, targets) => {
      observe(actor, targets);
      return targets.filter((t) => {
        try {
          assertSelectable(actor, bare(t));
          return true;
        } catch {
          return false;
        }
      });
    },
  };
}
