import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createProjects } from '../deploy/pi/projects.mjs';
import { createProjectFiles } from '../deploy/pi/project-files.mjs';
import { sandboxArgs } from '../deploy/pi/bash-sandbox.mjs';
const alice = { id: randomUUID(), username: 'alice', admin: false },
  bob = { id: randomUUID(), username: 'bob', admin: false };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'astral-member-projects-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'outside'));
  await writeFile(join(root, 'outside', 'private.txt'), 'outside');
  const config = {
    sources: [
      {
        id: 'workspace',
        name: 'Workspace',
        root,
        serverPath: '/opt/astral-projects',
        readOnly: false,
      },
    ],
    registryFile: join(root, 'registry.json'),
    backupDir: join(root, 'backups'),
    fullAccess: true,
  };
  return { root, config, registry: await createProjects(config) };
}
test('member projects stay under the username root and never inherit full administrator scope', async (t) => {
  const { registry } = await fixture(t);
  const a = await registry.ensureUser(alice),
    b = await registry.ensureUser(bob);
  await registry.files.mkdir(a.id, 'work');
  const p = await registry.create({ sourceId: a.id, path: 'work', name: 'Work' }, alice);
  assert.match(p.serverPath, /\/users\/alice\/work$/);
  assert.equal(p.ownerId, alice.id);
  await assert.rejects(
    registry.create({ sourceId: 'workspace', path: 'outside', name: 'Escape' }, alice),
    (e) => e.status === 403,
  );
  await assert.rejects(
    registry.create({ sourceId: b.id, path: '.', name: 'Other' }, alice),
    (e) => e.status === 403,
  );
  await assert.rejects(registry.authorize(alice, 'workspace'), (e) => e.status === 403);
  await assert.rejects(registry.authorize(bob, p.id), (e) => e.status === 403);
  assert.deepEqual((await registry.listFor(alice)).map((p) => p.id).sort(), [a.id, p.id].sort());
  assert.deepEqual(
    (await registry.authorize(alice, p.id, 'edit')).map((p) => p.id),
    [p.id],
  );
  const sandboxScope=await registry.authorize(alice,p.id,'edit');
  const args=await sandboxArgs(sandboxScope,sandboxScope[0].root,'pwd');
  assert.equal(args.includes(registry.files.project(b.id).root),false);
  assert.equal(args.includes(registry.files.project('workspace').root),false);
  assert.ok(
    (await registry.authorize({ id: randomUUID(), username: 'owner', admin: true }, p.id, 'read'))
      .length > 2,
  );
});
test('explicit read/edit grants survive reload and revoke without leaking other members', async (t) => {
  const { registry, config } = await fixture(t),
    a = await registry.ensureUser(alice);
  await registry.ensureUser(bob);
  await registry.files.mkdir(a.id, 'share');
  const p = await registry.create({ sourceId: a.id, path: 'share', name: 'Share' }, alice);
  await registry.files.write(p.id, 'note.txt', 'hello', 'new', 'edit');
  await registry.members(p.id, { userId: bob.id, username: bob.username, access: 'read' });
  let reloaded = await createProjects(config);
  const visible = (await reloaded.listFor(bob)).find((x) => x.id === p.id);
  assert.equal(visible.readOnly, true);
  assert.equal(visible.memberGrants, undefined);
  let files = createProjectFiles({
    projects: await reloaded.authorize(bob, p.id, 'read'),
    backupDir: config.backupDir,
  });
  assert.equal((await files.read(p.id, 'note.txt')).content, 'hello');
  await assert.rejects(reloaded.authorize(bob, p.id, 'edit'), (e) => e.status === 403);
  await reloaded.members(p.id, { userId: bob.id, username: bob.username, access: 'edit' });
  assert.equal((await reloaded.authorize(bob, p.id, 'edit'))[0].readOnly, false);
  await reloaded.members(p.id, { userId: bob.id, username: bob.username, access: null });
  await assert.rejects(reloaded.authorize(bob, p.id), (e) => e.status === 403);
  await reloaded.members('workspace', { userId: bob.id, username: bob.username, access: 'read' });
  reloaded = await createProjects(config);
  assert.equal((await reloaded.authorize(bob, 'workspace'))[0].readOnly, true);
});
test('username folders cannot claim pre-existing contents or follow changed ancestor links', async (t) => {
  const { root, registry } = await fixture(t);
  await mkdir(join(root, 'users'));
  await mkdir(join(root, 'users', 'alice'));
  await writeFile(join(root, 'users', 'alice', 'existing.txt'), 'unowned');
  await assert.rejects(registry.ensureUser(alice), (e) => e.status === 409);
  const dataUser = { id: randomUUID(), username: 'data', admin: false };
  const own = await registry.ensureUser(dataUser);
  assert.match(own.serverPath, /\/users\/data$/);
  await registry.files.mkdir(own.id, 'work');
  const p = await registry.create({ sourceId: own.id, path: 'work', name: 'Work' }, dataUser);
  const original = registry.files.project(own.id).root;
  const manifest=await registry.authorize(dataUser,p.id,'edit');
  await rename(original, original + '-old');
  await symlink(join(root, 'outside'), original);
  await assert.rejects(registry.authorize(dataUser, p.id));
  await assert.rejects(registry.files.list(p.id, '.'));
  await assert.rejects(sandboxArgs(manifest,manifest[0].root,'pwd'),error=>error.code==='ENOENT'||/实际路径/.test(error.message));
});

test('HTTP project operations use the authenticated member identity, explicit grants and native task scope', async (t) => {
  const { createApp } = await import('../server/index.mjs');
  const { root, registry } = await fixture(t),
    calls = [];
  const app = await createApp({
    token: 'synthetic-member-admin-'.repeat(3),
    dataDir: join(root, 'app-private'),
    piConfig: {
      url: 'http://synthetic-pi',
      token: 'private-bridge-test',
      fetch: async (url, options = {}) => {
        const u = new URL(url),
          p = options.body ? JSON.parse(options.body) : null,
          actor = options.headers?.['X-Astral-Project-Principal']
            ? JSON.parse(options.headers['X-Astral-Project-Principal'])
            : undefined;
        try {
          if (u.pathname === '/health') return Response.json({ ready: true, nativeSessions: true });
          if (u.pathname === '/projects' && !p)
            return Response.json({
              projects: actor ? await registry.listFor(actor) : registry.files.projects(),
            });
          if (u.pathname === '/projects' && p)
            return Response.json({ project: await registry.create(p, actor) });
          const route = u.pathname.match(/^\/projects\/([^/]+)\/(members|mkdir|read|list|write)$/);
          if (route) {
            const [, id, action] = route;
            if (action === 'members')
              return Response.json(
                p
                  ? { members: await registry.members(id, p) }
                  : { members: registry.files.project(id).memberGrants || [] },
              );
            const files = createProjectFiles({
              projects: await registry.authorize(
                actor,
                id,
                ['mkdir', 'write'].includes(action) ? 'edit' : 'read',
              ),
              backupDir: join(root, 'backups'),
            });
            if (action === 'mkdir') return Response.json(await files.mkdir(id, p.path));
            if (action === 'write')
              return Response.json(
                await files.write(id, p.path, p.content, p.expectedHash, 'edit'),
              );
            if (action === 'read')
              return Response.json(await files.read(id, u.searchParams.get('path')));
            return Response.json(await files.list(id, u.searchParams.get('path') || '.'));
          }
          if (u.pathname === '/run/stream') {
            calls.push(p);
            return new Response(
              JSON.stringify({ type: 'done', output: '合成任务已完成，无模型调用。', tools: [] }) +
                '\n',
              { headers: { 'Content-Type': 'application/x-ndjson' } },
            );
          }
          return Response.json({});
        } catch (e) {
          return Response.json({ error: e.message }, { status: e.status || 500 });
        }
      },
    },
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
  });
  const base = 'http://127.0.0.1:' + app.server.address().port + '/api';
  const request = async (path, data, auth, method, extra = {}) => {
    const r = await fetch(base + path, {
      method: method || (data ? 'POST' : 'GET'),
      headers: {
        Authorization: 'Bearer ' + (auth || ''),
        'Content-Type': 'application/json',
        ...extra,
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    return { status: r.status, body: await r.json() };
  };
  const owner = (
    await request('/auth/bootstrap', {
      username: 'owner',
      password: 'Synthetic-Password-0735!',
      displayName: 'Owner',
      adminToken: 'synthetic-member-admin-'.repeat(3),
    })
  ).body;
  const invitation = (await request('/auth/invitations', {}, owner.token)).body;
  const member = (
    await request('/auth/register', {
      username: 'member_a',
      password: 'Synthetic-Password-0735!',
      displayName: 'Member',
      invite: invitation.code,
    })
  ).body;
  const projects = (await request('/pi/projects', null, member.token)).body.projects;
  assert.equal(projects.length, 1);
  const own = projects[0];
  assert.equal(own.ownerId, member.user.id);
  assert.match(own.serverPath, /\/users\/member_a$/);
  assert.equal(
    (await request('/pi/preferences', null, member.token)).body.preferences.defaultProjectId,
    own.id,
  );
  assert.equal(
    (await request('/pi/projects/workspace/list?path=.', null, member.token)).status,
    403,
  );
  assert.equal(
    (
      await request('/pi/projects/workspace/list?path=.', null, member.token, undefined, {
        'X-Astral-Project-Principal': JSON.stringify({
          id: owner.user.id,
          username: 'owner',
          admin: true,
        }),
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        '/pi/projects',
        { sourceId: 'workspace', path: 'outside', name: 'escape' },
        member.token,
      )
    ).status,
    403,
  );
  assert.equal(
    (await request(`/pi/projects/${own.id}/mkdir`, { path: 'work' }, member.token)).status,
    200,
  );
  const created = await request(
    '/pi/projects',
    { sourceId: own.id, path: 'work', name: 'Work' },
    member.token,
  );
  assert.equal(created.status, 201);
  const project = created.body.project;
  assert.equal(
    (
      await request(
        `/pi/projects/${project.id}/grants`,
        { grants: [{ projectId: 'workspace', access: 'edit' }] },
        member.token,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        `/pi/projects/${project.id}/members`,
        { username: 'member_a', access: 'edit' },
        member.token,
      )
    ).status,
    403,
  );
  const shared = (
    await request(
      '/pi/projects',
      { sourceId: 'workspace', path: 'outside', name: 'Shared' },
      owner.token,
    )
  ).body.project;
  assert.equal(
    (
      await request(
        `/pi/projects/${shared.id}/members`,
        { username: 'member_a', access: 'read' },
        owner.token,
      )
    ).status,
    200,
  );
  assert.equal(
    (await request(`/pi/projects/${shared.id}/read?path=private.txt`, null, member.token)).body
      .content,
    'outside',
  );
  assert.equal(
    (
      await request(
        `/pi/projects/${shared.id}/write`,
        { path: 'bad.txt', content: 'denied', expectedHash: 'new' },
        member.token,
      )
    ).status,
    403,
  );
  const id = randomUUID(),
    conversationId = randomUUID();
  assert.equal(
    (
      await request(
        '/pi/tasks',
        {
          id,
          conversationId,
          input: 'Read only my project',
          projectId: project.id,
          access: 'read',
        },
        member.token,
      )
    ).status,
    202,
  );
  for (let i = 0; i < 30 && !calls.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].canManageSkills, false);
  assert.deepEqual(calls[0].projectPrincipal, {
    id: member.user.id,
    username: 'member_a',
    admin: false,
  });
  assert.equal(
    (
      await request(
        `/pi/projects/${shared.id}/members`,
        { username: 'member_a', access: null },
        owner.token,
      )
    ).status,
    200,
  );
  assert.equal(
    (await request(`/pi/projects/${shared.id}/read?path=private.txt`, null, member.token)).status,
    403,
  );
});
