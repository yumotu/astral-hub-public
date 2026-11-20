import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/index.mjs';
test('project display names persist per account without touching folders, permissions or bindings', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'astral-labels-'));
  await mkdir(join(dir, 'actual-folder'));
  await writeFile(join(dir, 'actual-folder', 'note.txt'), 'retained');
  const token = 'synthetic-project-label-admin-1234567890';
  let bridgeWrites = 0;
  const options = {
    token,
    dataDir: join(dir, 'data'),
    piConfig: {
      url: 'http://synthetic.invalid',
      token: 'synthetic',
      fetch: async (url, init) => {
        if (init.method !== 'GET') {
          bridgeWrites++;
          throw Error('No filesystem mutation allowed');
        }
        const principal = JSON.parse(init.headers['X-Astral-Project-Principal'] || '{}');
        if (url.endsWith('/projects'))
          return Response.json({
            projects: [
              {
                id: 'workspace',
                name: 'Original label',
                serverPath: join(dir, 'actual-folder'),
                readOnly: false,
                memberAccess: 'read',
              },
              ...(principal.admin ? [{ id: 'hidden', name: 'Admin only', readOnly: false }] : []),
            ],
          });
        return Response.json({ ready: true });
      },
    },
  };
  let app = await createApp(options);
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await new Promise((r) => app.server.close(r));
    await rm(dir, { recursive: true, force: true });
  });
  const req = async (path, data, auth, method) => {
    const r = await fetch('http://127.0.0.1:' + app.server.address().port + '/api' + path, {
      method: method || (data ? 'POST' : 'GET'),
      headers: {
        ...(auth ? { Authorization: 'Bearer ' + auth } : {}),
        ...(data ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    return { status: r.status, body: await r.json() };
  };
  const owner = (
    await req('/auth/bootstrap', {
      username: 'labelsowner',
      password: 'Synthetic-labels-password',
      displayName: 'Label QA',
      adminToken: token,
    })
  ).body;
  const invite = (await req('/auth/invitations', {}, owner.token)).body;
  const member = (
    await req('/auth/register', {
      username: 'labelsmember',
      password: 'Synthetic-labels-password',
      displayName: 'Member',
      invite: invite.code,
    })
  ).body;
  const route = '/pi/projects/workspace/display-name';
  assert.equal((await req(route, { name: '我的学习项目' }, member.token, 'PUT')).status, 200);
  const one = (await req('/pi/projects', null, member.token)).body.projects[0];
  assert.equal(one.name, '我的学习项目');
  assert.equal(one.id, 'workspace');
  assert.equal(one.readOnly, false);
  assert.equal(one.serverPath, join(dir, 'actual-folder'));
  assert.equal(
    (await req('/pi/projects', null, owner.token)).body.projects[0].name,
    'Original label',
  );
  assert.equal(
    (await req('/pi/projects/hidden/display-name', { name: 'No' }, member.token, 'PUT')).status,
    403,
  );
  assert.equal(
    (await req(route, { name: 'No', path: 'new-folder' }, member.token, 'PUT')).status,
    400,
  );
  assert.equal((await req(route, { name: 'No' }, token, 'PUT')).status, 401);
  await new Promise((r) => app.server.close(r));
  app = await createApp(options);
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  assert.equal(
    (await req('/pi/projects', null, member.token)).body.projects[0].name,
    '我的学习项目',
  );
  assert.equal(
    (await req(route, { name: null }, member.token, 'PUT')).body.project.name,
    'Original label',
  );
  assert.equal(await readFile(join(dir, 'actual-folder', 'note.txt'), 'utf8'), 'retained');
  assert.ok((await readdir(dir)).includes('actual-folder'));
  assert.equal(bridgeWrites, 0);
});
