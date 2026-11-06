import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/index.mjs';
import { documentFixtures } from './fixtures/document-files.mjs';
import { maxFileBytes } from '../server/files.mjs';

test('members can upload and send real-format attachments without sharing files or gaining administrator tools', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'astral-member-attachments-'));
  const admin = 'synthetic-member-upload-admin-'.repeat(2);
  const payloads = [];
  const app = await createApp({
    dataDir: dir,
    token: admin,
    piConfig: {
      url: 'http://synthetic-pi',
      token: 'synthetic-private-bridge',
      fetch: async (url, init) => {
        if (url.endsWith('/health')) return Response.json({ ready: true });
        if (url.endsWith('/run')) {
          payloads.push(JSON.parse(init.body));
          return Response.json({ output: 'Synthetic member attachment round trip.', tools: [] });
        }
        throw new Error('Unexpected bridge route ' + url);
      },
    },
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    await rm(dir, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + app.server.address().port + '/api';
  const request = async (path, body, auth) => {
    const response = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        ...(auth ? { Authorization: 'Bearer ' + auth } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  const owner = (await request('/auth/bootstrap', {
    username: 'uploadowner', displayName: 'Synthetic owner',
    password: 'Synthetic-Password-12345!', adminToken: admin,
  })).body;
  const members = [];
  for (const username of ['uploadmember_a', 'uploadmember_b']) {
    const invite = (await request('/auth/invitations', {}, owner.token)).body;
    const registered = await request('/auth/register', {
      username, displayName: 'Synthetic member',
      password: 'Synthetic-Password-12345!', invite: invite.code,
    });
    assert.equal(registered.status, 201);
    assert.equal(registered.body.user.role, 'member');
    members.push(registered.body);
  }
  const conversation = randomUUID(), attachments = [];
  const fixtures = [
    ...documentFixtures(),
    { name: '16MiB-member.txt', bytes: Buffer.alloc(16 * 1024 * 1024, 65) },
  ];
  for (const file of fixtures) {
    const response = await fetch(base + `/pi/conversations/${conversation}/files?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + members[0].token, 'Content-Type': 'application/octet-stream' },
      body: file.bytes,
    });
    const result = await response.json();
    assert.equal(response.status, 201, JSON.stringify(result));
    attachments.push(result.file.id);
    const path = `/pi/conversations/${conversation}/files/${result.file.id}`;
    const downloaded = await fetch(base + path, { headers: { Authorization: 'Bearer ' + members[0].token } });
    assert.equal(downloaded.status, 200);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), file.bytes);
    for (const auth of [owner.token, members[1].token])
      assert.equal((await request(path, undefined, auth)).status, 404);
    assert.equal((await request(path)).status, 401);
  }
  const boundary = Buffer.alloc(maxFileBytes, 66);
  const boundaryResponse = await fetch(base + `/pi/conversations/${conversation}/files?name=50MiB-boundary.txt`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + members[0].token, 'Content-Type': 'application/octet-stream' },
    body: boundary,
  });
  assert.equal(boundaryResponse.status, 201);
  const boundaryFile = (await boundaryResponse.json()).file;
  assert.equal(boundaryFile.bytes, maxFileBytes);
  assert.equal((await request(`/pi/conversations/${conversation}/files/${boundaryFile.id}`, undefined, members[1].token)).status, 404);
  attachments.push(boundaryFile.id);
  const turn = { id: randomUUID(), conversationId: conversation, input: '读取这些附件', attachments };
  assert.equal((await request('/pi/message', turn, members[1].token)).status, 404);
  assert.equal(payloads.length, 0);
  const sent = await request('/pi/message', turn, members[0].token);
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].canManageSkills, false);
  assert.equal(payloads[0].projectPrincipal.admin, false);
  assert.equal(payloads[0].projectPrincipal.id, members[0].user.id);
  assert.deepEqual(payloads[0].attachmentIds, attachments);
  assert.equal(payloads[0].files.length, fixtures.length + 1);
  assert.deepEqual(sent.body.turns[0].attachments.map((file) => file.id), attachments);
  assert.ok(sent.body.turns[0].attachments.every((file) => !('path' in file)));
});

test('chat uploads, model access and downloads are conversation/account scoped, bounded and persistent', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'astral-chat-files-')),
    admin = 'test-admin-token-00000000000000000000000';
  let captured;
  let generated = [{ name: 'summary.md', content: 'Summary: 2468' }];
  const options = {
    dataDir: dir,
    token: admin,
    piConfig: {
      url: 'http://mock',
      token: 'internal-only',
      fetch: async (url, init) => {
        if (url.endsWith('/health'))
          return Response.json({
            ready: true,
            nativeSessions: true,
            streaming: true,
            vision: true,
            webSearch: true,
          });
        if (url.endsWith('/sessions/delete')) return Response.json({ ok: true });
        if (url.endsWith('/run')) {
          captured = JSON.parse(init.body);
          return Response.json({
            output: '已读取附件并整理成文件',
            tools: [],
            exports: generated,
          });
        }
        throw new Error('Unexpected bridge route ' + url);
      },
    },
  };
  let app = await createApp(options);
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  let base = 'http://127.0.0.1:' + app.server.address().port + '/api';
  t.after(async () => {
    await new Promise((r) => app.server.close(r));
    await rm(dir, { recursive: true, force: true });
  });
  const request = async (path, data, token, method) => {
    const r = await fetch(base + path, {
      method: method || (data ? 'POST' : 'GET'),
      headers: {
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(data ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    return { status: r.status, body: await r.json() };
  };
  const owner = (
    await request('/auth/bootstrap', {
      username: 'fileowner',
      displayName: 'Owner',
      password: 'Test-Password-12345!',
      adminToken: admin,
    })
  ).body;
  const invitation = (await request('/auth/invitations', {}, owner.token)).body;
  const member = (
    await request('/auth/register', {
      username: 'filemember',
      displayName: 'Member',
      password: 'Test-Password-12345!',
      invite: invitation.code,
    })
  ).body;
  const conversation = randomUUID();
  const upload = async (name, bytes, token = owner.token) =>
    fetch(base + `/pi/conversations/${conversation}/files?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/octet-stream' },
      body: bytes,
    });
  assert.equal((await upload('../escape', 'no')).status, 400);
  assert.equal((await upload('large.txt', Buffer.alloc(maxFileBytes + 1))).status, 413);
  const uploaded = await upload('notes.txt', 'This file contains 2468.');
  assert.equal(uploaded.status, 201);
  const file = (await uploaded.json()).file;
  const path = `/pi/conversations/${conversation}/files/${file.id}`;
  assert.equal((await fetch(base + path)).status, 401);
  assert.equal((await request(path, undefined, member.token)).status, 404);
  assert.equal(
    (await request(`/pi/conversations/${randomUUID()}/files/${file.id}`, undefined, owner.token))
      .status,
    404,
  );
  const downloaded = await fetch(base + path, {
    headers: { Authorization: 'Bearer ' + owner.token },
  });
  assert.equal(await downloaded.text(), 'This file contains 2468.');
  assert.match(downloaded.headers.get('content-disposition'), /attachment/);
  const turn = {
    id: randomUUID(),
    conversationId: conversation,
    input: '读取附件',
    attachments: [file.id],
  };
  assert.equal(
    (
      await request(
        '/pi/message',
        { ...turn, id: randomUUID(), conversationId: randomUUID() },
        owner.token,
      )
    ).status,
    404,
  );
  const sent = await request('/pi/message', turn, owner.token);
  assert.equal(sent.status, 200);
  assert.equal(captured.files.length, 1);
  assert.equal(captured.files[0].id, file.id);
  assert.equal(captured.attachmentIds[0], file.id);
  assert.equal('path' in sent.body.turns[0].attachments[0], false);
  const artifact = sent.body.turns[0].artifacts[0];
  assert.equal(artifact.name, 'summary.md');
  assert.equal(
    await (
      await fetch(base + `/pi/conversations/${conversation}/files/${artifact.id}`, {
        headers: { Authorization: 'Bearer ' + owner.token },
      })
    ).text(),
    'Summary: 2468',
  );
  assert.equal((await request(path, undefined, owner.token, 'DELETE')).status, 409);
  assert.equal(
    (await request('/pi/message', { ...turn, attachments: [] }, owner.token)).status,
    409,
  );
  const formats = documentFixtures();
  const uploads = [];
  for (const file of formats) {
    const result = await upload(file.name, file.bytes);
    assert.equal(result.status, 201);
    uploads.push((await result.json()).file.id);
  }
  generated = formats.map((file) => ({ name: file.name, encoding: 'base64', data: file.bytes.toString('base64') }));
  const allFormats = await request('/pi/message', { ...turn, id: randomUUID(), input: '五类文件往返验收', attachments: uploads }, owner.token);
  assert.equal(allFormats.status, 200);
  assert.equal(captured.attachmentIds.length, 5);
  const sentFiles = allFormats.body.turns.at(-1).artifacts;
  assert.equal(sentFiles.length, 5);
  for (const file of sentFiles) {
    const response = await fetch(base + `/pi/conversations/${conversation}/files/${file.id}`, { headers: { Authorization: 'Bearer ' + owner.token } });
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), formats.find((format) => format.name === file.name).bytes);
    assert.equal((await request(`/pi/conversations/${conversation}/files/${file.id}`, undefined, member.token)).status, 404);
  }
  await new Promise((r) => app.server.close(r));
  app = await createApp(options);
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + app.server.address().port + '/api';
  assert.equal(
    (await request(`/pi/conversations/${conversation}`, undefined, owner.token)).body.turns[0]
      .attachments[0].id,
    file.id,
  );
  assert.equal(
    (await request(`/pi/conversations/${conversation}`, undefined, owner.token, 'DELETE')).status,
    200,
  );
  assert.equal((await request(path, undefined, owner.token)).status, 404);
});
