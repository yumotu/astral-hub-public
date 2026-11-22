import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/index.mjs';

test('SuperAgent API persists Leader tasks for subagent reporting', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'astral-superagent-api-'));
  const adminToken = 'superagent-api-admin-token-12345678901234567890';
  const app = await createApp({ token: adminToken, dataDir: dir, notifications: { start: false } });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api`;
  async function request(path, token, method = 'GET', payload) {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(payload ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    return { status: response.status, body: await response.json() };
  }
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const owner = await request('/auth/bootstrap', adminToken, 'POST', {
    username: 'superagentowner',
    displayName: 'SuperAgent Owner',
    password: 'superagent-test-password',
    adminToken,
  });
  assert.equal(owner.status, 201);
  const taskId = randomUUID();
  const created = await request('/superagent/tasks', owner.body.token, 'POST', {
    id: taskId,
    title: '整理测试任务',
    input: '请把测试任务委派给 subagent',
    runtime: 'DPH',
  });
  assert.equal(created.status, 202);
  assert.equal(created.body.task.executor, 'subagent');
  assert.equal((await request('/superagent/tasks', owner.body.token)).body.counts.active, 1);
  const updated = await request(`/superagent/tasks/${taskId}`, owner.body.token, 'PATCH', {
    status: 'running',
    revision: created.body.task.revision,
    progress: 50,
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.task.progress, 50);
  const waiting = await request(`/superagent/tasks/${taskId}`, owner.body.token, 'PATCH', {
    status: 'waiting_user',
    revision: updated.body.task.revision,
    attention: '请确认下一步',
  });
  assert.equal(waiting.body.task.status, 'waiting_user');
  assert.equal((await request('/superagent/tasks', owner.body.token)).body.counts.waiting, 1);
});

test('SuperAgent API dispatches only through an explicitly configured runtime adapter', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'astral-superagent-adapter-'));
  const adminToken = 'superagent-adapter-admin-token-12345678901234567890';
  const app = await createApp({
    token: adminToken,
    dataDir: dir,
    notifications: { start: false },
    subagentAdapters: {
      DPH: {
        async start({ report }) {
          report({ status: 'running', progress: 25, report: 'adapter started' });
          return { status: 'succeeded', progress: 100, report: 'adapter finished' };
        },
      },
    },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api`;
  async function request(path, token, method = 'GET', payload) {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(payload ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    return { status: response.status, body: await response.json() };
  }
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const owner = await request('/auth/bootstrap', adminToken, 'POST', {
    username: 'superagentadapter',
    displayName: 'SuperAgent Adapter',
    password: 'superagent-adapter-password',
    adminToken,
  });
  const created = await request('/superagent/tasks', owner.body.token, 'POST', {
    id: randomUUID(),
    title: '适配器任务',
    input: '运行合成 DPH 适配器',
    runtime: 'DPH',
  });
  assert.equal(created.status, 202);
  let current;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    current = (await request(`/superagent/tasks/${created.body.task.id}`, owner.body.token)).body.task;
    if (current.status === 'succeeded') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(current.status, 'succeeded');
  assert.equal(current.executor, 'subagent');
});
