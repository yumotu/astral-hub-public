import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'astral-computer-files-'));
  const admin = 'synthetic-artifact-admin-12345678901234567890';
  const app = await createApp({ dataDir: dir, token: admin });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.server.address().port + '/api';
  const req = async (path, data, auth, method) => {
    const r = await fetch(base + path, {
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
      username: 'artifactowner',
      password: 'Synthetic-artifact-password',
      displayName: 'Artifact',
      adminToken: admin,
    })
  ).body;
  const invite = (await req('/auth/invitations', {}, owner.token)).body;
  const other = (
    await req('/auth/register', {
      username: 'artifactother',
      password: 'Synthetic-artifact-password',
      displayName: 'Other',
      invite: invite.code,
    })
  ).body;
  const enroll = async () => {
    const code = (await req('/relay/pairing', {}, owner.token)).body.code;
    const d = (
      await req('/relay/device/enroll', {
        code,
        name: 'Artifact computer',
        platform: 'darwin',
        rootLabel: 'fixture',
        allowWrite: false,
      })
    ).body;
    const projectId = randomUUID();
    assert.equal(
      (
        await req(
          '/relay/device/workspace/announce',
          {
            version: 2,
            projects: [{ id: projectId, name: 'readonly', allowWrite: false, allowExecute: false }],
          },
          d.token,
        )
      ).status,
      200,
    );
    return { ...d, projectId };
  };
  const device = await enroll();
  const submit = async (deviceId = device.deviceId, projectId = device.projectId) => {
    const job = {
      id: randomUUID(),
      deviceId,
      projectId,
      conversationId: randomUUID(),
      input: 'send an existing file',
      access: 'read',
      execute: false,
      deliveryPreference: 'queue',
    };
    assert.equal((await req('/relay/submissions', job, owner.token)).status, 202);
    return job;
  };
  const job = await submit();
  assert.equal(
    (await req('/relay/device/workspace/jobs/poll?capacity=2', undefined, device.token)).body.job
      .id,
    job.id,
  );
  const upload = async (id, name, bytes, auth = device.token, target = job.id) => {
    const r = await fetch(base + `/relay/device/workspace/jobs/${target}/files/${id}`, {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer ' + auth,
        'Content-Type': 'application/octet-stream',
        'X-Astral-File-Name': encodeURIComponent(name),
      },
      body: bytes,
    });
    return { status: r.status, body: await r.json() };
  };
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    await rm(dir, { recursive: true, force: true });
  });
  return { app, base, req, owner, other, device, enroll, submit, job, upload };
}

test('read-only computer tasks deliver exact binary artifacts, isolate owners and persist history without base64 in model state', async (t) => {
  const f = await fixture(t),
    id = randomUUID(),
    bytes = Buffer.alloc(3 * 1024 * 1024, 0xab);
  const before = (
    await f.req('/relay/conversations/' + f.job.conversationId, undefined, f.owner.token)
  ).body.conversation.version;
  const result = await f.upload(id, '现有图片.png', bytes);
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(result.body.file.bytes, bytes.length);
  assert.equal(result.body.file.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal((await f.upload(id, '现有图片.png', bytes)).status, 200);
  assert.equal((await f.upload(id, '现有图片.png', Buffer.from('changed'))).status, 409);
  assert.equal((await f.upload(randomUUID(), 'bad/name.png', bytes)).status, 400);
  const second = await f.enroll();
  assert.equal((await f.upload(randomUUID(), 'no.png', bytes, second.token)).status, 404);
  assert.equal((await f.upload(randomUUID(), 'no.png', bytes, f.other.token)).status, 401);
  const history = (
    await f.req('/relay/conversations/' + f.job.conversationId, undefined, f.owner.token)
  ).body;
  assert.notEqual(history.conversation.version, before, 'files must invalidate the history cache');
  assert.deepEqual(history.jobs[0].artifacts, [result.body.file]);
  assert.equal(JSON.stringify(history).includes('base64'), false);
  const path = `/pi/conversations/${f.job.conversationId}/files/${id}`;
  const download = await fetch(f.base + path, {
    headers: { Authorization: 'Bearer ' + f.owner.token },
  });
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  assert.equal((await f.req(path, undefined, f.other.token)).status, 404);
  assert.equal(
    (await f.req(path, undefined, f.owner.token, 'DELETE')).status,
    409,
    'a delivered file must stay attached to its history',
  );
  await f.req(
    `/relay/device/workspace/jobs/${f.job.id}/result`,
    { revision: 1, output: 'sent', thinking: '', phase: 'done', tools: [], status: 'done' },
    f.device.token,
  );
  assert.equal(
    (await f.req(`/relay/device/workspace/jobs/${f.job.id}/files/${id}`, undefined, f.device.token))
      .body.file.sha256,
    result.body.file.sha256,
  );
  assert.equal((await f.upload(randomUUID(), 'late.txt', Buffer.from('late'))).status, 409);
});

test('computer artifact upload rejects oversized, cancelled and revoked operations and enforces task quotas', async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.upload(randomUUID(), 'large.bin', Buffer.alloc(10 * 1024 * 1024 + 1))).status,
    413,
  );
  assert.equal(
    (await f.upload(randomUUID(), 'first.bin', Buffer.alloc(10 * 1024 * 1024))).status,
    201,
  );
  assert.equal(
    (await f.upload(randomUUID(), 'second.bin', Buffer.alloc(10 * 1024 * 1024))).status,
    201,
  );
  assert.equal((await f.upload(randomUUID(), 'overflow.bin', Buffer.from('x'))).status, 413);
  await f.req('/relay/jobs/' + f.job.id + '/cancel', {}, f.owner.token);
  assert.equal((await f.upload(randomUUID(), 'cancelled.txt', Buffer.from('x'))).status, 409);
  const job = await f.submit();
  await f.req('/relay/device/workspace/jobs/poll?capacity=2', undefined, f.device.token);
  await f.req('/relay/device/workspace/announce', { version: 2, projects: [] }, f.device.token);
  assert.equal(
    (await f.upload(randomUUID(), 'revoked.txt', Buffer.from('x'), f.device.token, job.id)).status,
    409,
  );
});
