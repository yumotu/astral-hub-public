import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAppFunctions } from '../server/app-functions.mjs';
import { registerProjectManagementFeatures } from '../server/app-feature-tools.mjs';
import { fail } from '../server/accounts.mjs';
import { createApp } from '../server/index.mjs';

const targetKey = (p) =>
  JSON.stringify([p.origin, p.projectId ?? null, p.deviceId ?? null, p.connectionId ?? null]);

function fixture(t) {
  const db = new DatabaseSync(':memory:'),
    deviceId = randomUUID(),
    connectionId = randomUUID(),
    projectId = randomUUID(),
    projects = [
      {
        target: { origin: 'server', projectId: 'server-project' },
        name: '服务器项目',
        revision: 1,
      },
      { target: { origin: 'computer', deviceId, projectId }, name: '电脑项目', revision: 1 },
      {
        target: { origin: 'remote', connectionId, projectId: 'workspace:one' },
        name: 'Remote项目',
        revision: 1,
      },
    ].map((p) => ({ ...p, originalName: p.name, removedAt: null })),
    computers = [
      { target: { origin: 'computer', deviceId }, name: '同名电脑', removedAt: null, revision: 1 },
      {
        target: { origin: 'remote', connectionId },
        name: '同名电脑',
        removedAt: null,
        revision: 1,
        hostId: 'independent-remote-host',
      },
    ],
    counters = { rename: 0, remove: 0, restore: 0, revoke: 0 },
    requests = [];
  let active = true,
    blocked = false,
    unknownAfterMutation = false,
    clock = 1000;
  const find = (actor, kind, target) => {
    const item =
      actor.id === 'alice'
        ? (kind === 'computers' ? computers : projects).find(
            (v) => targetKey(v.target) === targetKey(target),
          )
        : null;
    if (!item) throw fail(404, '对象不存在。');
    return item;
  };
  async function mutate(actor, p, action, kind = 'projects') {
    const item = find(actor, kind, p.target);
    requests.push({ owner: actor.id, action });
    if (action === 'rename') {
      item.name = p.name ?? item.originalName;
      item.revision++;
      counters.rename++;
    } else {
      if (p.revision !== item.revision) throw fail(409, '对象已变化。');
      if (blocked && kind === 'projects') throw fail(409, '项目有运行任务。');
      if (action === 'restore') {
        item.removedAt = null;
        counters.restore++;
      } else {
        item.removedAt = '2026-11-16T00:00:00.000Z';
        if (kind === 'computers') {
          counters.revoke++;
          active = false;
        } else counters.remove++;
      }
      item.revision++;
      if (unknownAfterMutation) throw Error('synthetic transport lost after business mutation');
    }
    return { ok: true, item: structuredClone(item) };
  }
  const management = {
    list(actor) {
      assert.ok(actor.id === 'alice' || actor.id === 'bob');
      requests.push({ owner: actor.id, action: 'list' });
      return structuredClone(
        actor.id === 'alice' ? { projects, computers } : { projects: [], computers: [] },
      );
    },
    previewProject(actor, target) {
      const item = find(actor, 'projects', target);
      if (blocked) throw fail(409, '项目有运行任务。');
      return structuredClone(item);
    },
    previewComputer: (actor, target) => structuredClone(find(actor, 'computers', target)),
    rename: (actor, p) => mutate(actor, p, 'rename'),
    remove: (actor, p) => mutate(actor, p, 'remove'),
    restore: (actor, p) => mutate(actor, p, 'restore'),
    removeComputer: (actor, p) => mutate(actor, p, 'removeComputer', 'computers'),
  };
  const engine = createAppFunctions(db, {
    token: 'synthetic-project-management-private-key'.repeat(2),
    profile: (id) => ({ id, space: 'space-' + id }),
    isActive: () => active,
    body: async (req) => req.input,
    now: () => clock,
  });
  registerProjectManagementFeatures(engine, management);
  const context = { owner: 'alice', task: randomUUID(), conversation: randomUUID(), origin: 'pi' };
  let call = 0;
  const invoke = (name, input = {}, ctx = context, callId = 'management-' + ++call) =>
    engine.execute(ctx, { action: 'invoke', name, input, callId });
  t.after(() => {
    engine.close();
    db.close();
  });
  return {
    db,
    engine,
    context,
    invoke,
    projects,
    computers,
    counters,
    requests,
    block: () => {
      blocked = true;
    },
    deactivate: () => {
      active = false;
    },
    expire: () => {
      clock += 6 * 60000;
    },
    uncertain: () => {
      unknownAfterMutation = true;
    },
  };
}

test('project management tools expose one strict account-scoped catalog for server, computer and Remote', async (t) => {
  const f = fixture(t),
    catalog = await f.engine.execute(f.context, { action: 'catalog' });
  assert.deepEqual(
    catalog.functions.map((p) => [p.name, p.confirmation]),
    [
      ['assistant.projects', false],
      ['assistant.project_rename', false],
      ['assistant.project_remove', true],
      ['assistant.project_restore', false],
      ['assistant.computer_remove', true],
    ],
  );
  const result = await f.invoke('assistant.projects');
  assert.equal(result.result.projects.length, 3);
  assert.equal(result.result.computers.length, 2);
  assert.notDeepEqual(result.result.computers[0].target, result.result.computers[1].target);
  assert.equal(
    (await f.invoke('assistant.projects', {}, { ...f.context, owner: 'bob' })).result.projects
      .length,
    0,
  );
  for (const input of [{ owner: 'bob' }, { target: f.projects[0].target }])
    await assert.rejects(f.invoke('assistant.projects', input));
  await assert.rejects(
    f.invoke('assistant.project_remove', {
      target: { ...f.projects[0].target, path: '/private' },
      revision: 0,
    }),
  );
  await assert.rejects(
    f.invoke('assistant.project_remove', {
      target: { origin: 'server', projectId: null },
      revision: 0,
    }),
  );
  await assert.rejects(
    f.invoke('assistant.computer_remove', {
      target: { origin: 'server', connectionId: randomUUID() },
      revision: 0,
    }),
  );
  await assert.rejects(
    f.invoke('assistant.project_remove', {
      target: f.projects[0].target,
      revision: -1,
    }),
  );
});

test('renames reuse business routes, only change display names and allow returning to the original', async (t) => {
  const f = fixture(t);
  for (const item of f.projects) {
    const before = structuredClone(item.target);
    assert.equal(
      (
        await f.invoke('assistant.project_rename', {
          target: item.target,
          name: '新显示名',
        })
      ).state,
      'done',
    );
    assert.equal(item.name, '新显示名');
    assert.deepEqual(item.target, before);
    await f.invoke('assistant.project_rename', { target: item.target, name: null });
    assert.equal(item.name, item.originalName);
  }
  assert.equal(f.counters.rename, 6);
  await assert.rejects(
    f.invoke('assistant.project_rename', {
      target: f.projects[0].target,
      name: '非法\n名称',
    }),
  );
  await assert.rejects(
    f.invoke('assistant.project_rename', {
      target: f.projects[0].target,
      name: 'a'.repeat(61),
    }),
  );
  await assert.rejects(
    f.invoke(
      'assistant.project_rename',
      {
        target: f.projects[0].target,
        name: '别人的',
      },
      { ...f.context, owner: 'bob' },
    ),
    /不存在/,
  );
  assert.equal(f.requests.filter((p) => p.action === 'rename').length, 6);
});

test('project removal freezes names and revisions, requires confirmation, and replays neither cancelled nor repeated approvals', async (t) => {
  const f = fixture(t),
    item = f.projects[1],
    p = { target: item.target, revision: item.revision };
  const first = await f.invoke('assistant.project_remove', p);
  assert.equal(first.state, 'prepared');
  assert.match(first.preview.text, /电脑项目.*文件.*历史/);
  assert.equal(f.counters.remove, 0);
  assert.equal(item.removedAt, null);
  await assert.rejects(f.engine.respond('bob', first.id, true), /不存在/);
  assert.equal((await f.engine.respond('alice', first.id, false)).state, 'denied');
  assert.equal((await f.engine.respond('alice', first.id, true)).state, 'denied');
  assert.equal(f.counters.remove, 0);
  const stale = await f.invoke('assistant.project_remove', p);
  await f.invoke('assistant.project_rename', { target: item.target, name: '现在的名字' });
  await assert.rejects(f.engine.respond('alice', stale.id, true), /已变化/);
  assert.equal(f.counters.remove, 0);
  await assert.rejects(f.invoke('assistant.project_remove', p), /已变化/);
  const current = await f.invoke('assistant.project_remove', {
    target: item.target,
    revision: item.revision,
  });
  const results = await Promise.all([
    f.engine.respond('alice', current.id, true),
    f.engine.respond('alice', current.id, true),
  ]);
  assert.ok(results.some((r) => r.state === 'done'));
  assert.equal(f.counters.remove, 1);
  assert.equal((await f.engine.respond('alice', current.id, true)).state, 'done');
  assert.equal(f.counters.remove, 1);
  const restored = await f.invoke('assistant.project_restore', {
    target: item.target,
    revision: item.revision,
  });
  assert.equal(restored.state, 'done');
  assert.equal(item.removedAt, null);
  assert.equal(f.counters.restore, 1);
});

test('deleting computers keeps same-name connections distinct and records completion even when it revokes the invoking task', async (t) => {
  const f = fixture(t),
    computer = f.computers[0];
  const prepared = await f.invoke(
    'assistant.computer_remove',
    {
      target: computer.target,
      revision: computer.revision,
    },
    { ...f.context, origin: 'computer' },
  );
  assert.equal(prepared.state, 'prepared');
  assert.match(prepared.preview.text, /同名电脑.*撤销凭据.*任务和终端/);
  assert.equal(f.counters.revoke, 0);
  assert.equal((await f.engine.respond('alice', prepared.id, true)).state, 'done');
  assert.equal(f.counters.revoke, 1);
  assert.ok(computer.removedAt);
  assert.equal(f.computers[1].removedAt, null);
  assert.equal((await f.engine.respond('alice', prepared.id, true)).state, 'done');
  assert.equal(f.counters.revoke, 1);
  const request = f.db
    .prepare('SELECT state FROM app_function_calls WHERE owner=? AND id=?')
    .get('alice', prepared.id);
  assert.equal(request.state, 'done');
  const g = fixture(t);
  const remote = await g.invoke('assistant.computer_remove', {
    target: g.computers[1].target,
    revision: g.computers[1].revision,
  });
  assert.match(remote.preview.text, /DPH连接及终端授权.*远端任务可能继续运行/);
  assert.doesNotMatch(remote.preview.text, /停止其任务/);
});

test('computer previews reject changed host identity, revision and names before revoking a connection', async (t) => {
  const f = fixture(t),
    computer = f.computers[1];
  for (const mutate of [
    () => {
      computer.hostId = 'different-host';
    },
    () => {
      computer.name = '名称变化';
    },
    () => {
      computer.revision++;
    },
  ]) {
    const p = await f.invoke('assistant.computer_remove', {
      target: computer.target,
      revision: computer.revision,
    });
    mutate();
    await assert.rejects(f.engine.respond('alice', p.id, true), /已变化/);
  }
  assert.equal(f.counters.revoke, 0);
});

test('inactive or expired approvals and running projects do not bypass business checks', async (t) => {
  const f = fixture(t),
    target = f.projects[0].target;
  const prepared = await f.invoke('assistant.project_remove', { target, revision: 1 });
  f.block();
  await assert.rejects(f.engine.respond('alice', prepared.id, true), /运行任务/);
  assert.equal(f.counters.remove, 0);
  const g = fixture(t),
    pending = await g.invoke('assistant.project_remove', {
      target: g.projects[0].target,
      revision: 1,
    });
  g.deactivate();
  await assert.rejects(g.engine.respond('alice', pending.id, true), /已结束/);
  assert.equal(g.counters.remove, 0);
  const h = fixture(t),
    expired = await h.invoke('assistant.project_remove', {
      target: h.projects[0].target,
      revision: 1,
    });
  h.expire();
  await assert.rejects(h.engine.respond('alice', expired.id, true), /过期/);
  assert.equal(h.counters.remove, 0);
});

test('lost deletion results remain unknown without replaying the business mutation', async (t) => {
  const f = fixture(t),
    input = { target: f.projects[2].target, revision: 1 };
  const prepared = await f.invoke('assistant.project_remove', input, f.context, 'lost-remove');
  f.uncertain();
  assert.equal((await f.engine.respond('alice', prepared.id, true)).state, 'unknown');
  assert.equal(f.counters.remove, 1);
  assert.equal((await f.engine.respond('alice', prepared.id, true)).state, 'unknown');
  assert.equal(
    (await f.invoke('assistant.project_remove', input, f.context, 'lost-remove')).state,
    'unknown',
  );
  assert.equal(f.counters.remove, 1);
});

test('actual main-chat app capability shares management routes, preserves files and isolates project navigation', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'astral-management-app-tools-')),
    folder = join(dir, 'actual-folder'),
    adminToken = 'synthetic-management-app-tools-admin-token-1234567890';
  await mkdir(folder);
  await writeFile(join(folder, 'retained.txt'), 'retained project bytes');
  let payload, release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const app = await createApp({
    token: adminToken,
    dataDir: join(dir, 'data'),
    notifications: { start: false },
    generateTitle: async () => '合成管理工具验证',
    piConfig: {
      url: 'http://synthetic-management-pi',
      token: 'synthetic-private-bridge',
      fetch: async (url, init) => {
        if (url.endsWith('/health')) return Response.json({ ready: true, nativeSessions: false });
        if (url.endsWith('/projects'))
          return Response.json({
            projects: [
              { id: 'active', name: 'Active task project', readOnly: false, memberAccess: 'read' },
              {
                id: 'workspace',
                name: 'Actual folder',
                serverPath: folder,
                readOnly: false,
                memberAccess: 'read',
              },
            ],
          });
        if (url.endsWith('/schedules/pending')) return Response.json({ runs: [] });
        if (url.endsWith('/cancel')) {
          release();
          return Response.json({ ok: true });
        }
        payload = JSON.parse(init.body);
        await hold;
        return Response.json({ output: 'synthetic management tool task done' });
      },
    },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    release();
    await new Promise((resolve) => app.server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const req = async (path, input, token, method) => {
    const response = await fetch('http://127.0.0.1:' + app.server.address().port + '/api' + path, {
      method: method || (input ? 'POST' : 'GET'),
      headers: {
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(input ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(input ? { body: JSON.stringify(input) } : {}),
    });
    return { status: response.status, ...(await response.json()) };
  };
  const owner = await req('/auth/bootstrap', {
    username: 'managementowner',
    displayName: '管理工具验收',
    password: 'synthetic-only-password',
    adminToken,
  });
  const invite = await req('/auth/invitations', {}, owner.token);
  const other = await req('/auth/register', {
    username: 'managementother',
    displayName: '其他账号',
    password: 'synthetic-only-password',
    invite: invite.code,
  });
  const task = randomUUID(),
    conversationId = randomUUID();
  assert.equal(
    (
      await req(
        '/pi/tasks',
        {
          id: task,
          conversationId,
          projectId: 'active',
          input: 'synthetic management tools task',
        },
        owner.token,
      )
    ).status,
    202,
  );
  for (let i = 0; !payload?.appAccess && i < 100; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(payload?.appAccess);
  let call = 0;
  const tool = async (name, input = {}) =>
    req(
      '/pi/app-access',
      {
        action: 'invoke',
        name,
        input,
        callId: 'actual-management-' + ++call,
      },
      payload.appAccess.token,
    );
  const confirmation = (id, action = 'confirm', token = owner.token) =>
    req('/app-functions/requests/' + id + '/' + action, {}, token);
  await req('/assistant/targets?backend=pi', undefined, owner.token);
  await req('/assistant/targets?backend=pi', undefined, other.token);
  const catalog = await req('/pi/app-access', { action: 'catalog' }, payload.appAccess.token);
  assert.ok(catalog.functions.some((f) => f.name === 'assistant.project_remove'));
  const listing = await tool('assistant.projects');
  let project = listing.result.projects.find((p) => p.target.projectId === 'workspace');
  assert.ok(project);
  assert.equal(project.revision, 1);
  const target = { origin: 'server', projectId: 'workspace' };
  const named = await tool('assistant.project_rename', { target, name: '工具显示名称' });
  assert.equal(named.state, 'done');
  assert.equal(
    named.result.project.name,
    '工具显示名称',
    JSON.stringify({
      named,
      labels: app.store.db.prepare('SELECT * FROM project_display_names').all(),
    }),
  );
  project = (await tool('assistant.projects')).result.projects.find(
    (p) => p.target.projectId === 'workspace',
  );
  assert.equal(project.name, '工具显示名称');
  const stale = await tool('assistant.project_remove', { target, revision: project.revision });
  assert.equal(stale.state, 'prepared');
  assert.match(stale.preview.text, /工具显示名称/);
  const renamed = await req(
    '/assistant/project-management/display-name',
    { target, name: '界面新名称' },
    owner.token,
    'PUT',
  );
  assert.equal(renamed.status, 200);
  assert.equal((await confirmation(stale.id)).status, 409);
  project = renamed.project;
  const cancelled = await tool('assistant.project_remove', { target, revision: project.revision });
  const denied = await confirmation(cancelled.id, 'deny');
  assert.equal(denied.status, 200);
  assert.equal(denied.state, 'denied');
  const prepared = await tool('assistant.project_remove', { target, revision: project.revision });
  assert.equal((await confirmation(prepared.id, 'confirm', other.token)).status, 404);
  assert.equal((await confirmation(prepared.id)).state, 'done');
  assert.equal((await confirmation(prepared.id)).state, 'done');
  const removed = (
    await req('/assistant/project-management', undefined, owner.token)
  ).projects.find((p) => p.target.projectId === 'workspace');
  assert.ok(removed.removedAt);
  assert.equal(
    (await req('/assistant/project-management', undefined, other.token)).projects.find(
      (p) => p.target.projectId === 'workspace',
    ).removedAt,
    null,
  );
  assert.ok(
    !(await req('/assistant/targets?backend=pi', undefined, owner.token)).targets.some(
      (p) => p.projectId === 'workspace',
    ),
  );
  assert.equal(
    (await tool('assistant.project_restore', { target, revision: removed.revision })).state,
    'done',
  );
  assert.ok(
    (await req('/assistant/targets?backend=pi', undefined, owner.token)).targets.some(
      (p) => p.projectId === 'workspace',
    ),
  );
  assert.equal(await readFile(join(folder, 'retained.txt'), 'utf8'), 'retained project bytes');
  assert.equal(
    (await tool('assistant.project_rename', { target, name: null })).result.project.name,
    'Actual folder',
  );
});
