import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/index.mjs';

test('server HTTP question continuation preserves scope, rechecks authorization and never replays the old task', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'astral-resume-api-')),
    admin = 'synthetic-resume-admin-token-123456789';
  const runs = [],
    cancels = [];
  let writable = true;
  const app = await createApp({
    token: admin,
    dataDir: dir,
    piConfig: {
      url: 'http://synthetic-pi',
      token: 'synthetic-only',
      fetch: async (url, options) => {
        const p = options?.body ? JSON.parse(options.body) : {};
        if (url.endsWith('/health')) return Response.json({ ready: true, nativeSessions: true });
        if (url.endsWith('/projects'))
          return Response.json({ projects: [{ id: 'alpha', readOnly: !writable }] });
        if (url.endsWith('/schedules/pending')) return Response.json({ runs: [] });
        if (url.endsWith('/cancel')) {
          cancels.push(p);
          return Response.json({ ok: true });
        }
        if (url.endsWith('/run/stream')) {
          runs.push(p);
          return new Response(
            JSON.stringify({
              type: 'done',
              output: 'Continued after the actual answer',
              tools: [],
            }) + '\n',
            { headers: { 'Content-Type': 'application/x-ndjson' } },
          );
        }
        return Response.json({});
      },
    },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const req = async (path, data, auth) => {
    const r = await fetch('http://127.0.0.1:' + app.server.address().port + '/api' + path, {
      method: data ? 'POST' : 'GET',
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
      username: 'resumeowner',
      password: 'Synthetic-resume-password',
      displayName: 'Owner',
      adminToken: admin,
    })
  ).body;
  const invite = (await req('/auth/invitations', {}, owner.token)).body;
  const other = (
    await req('/auth/register', {
      username: 'resumeother',
      password: 'Synthetic-resume-password',
      displayName: 'Other',
      invite: invite.code,
    })
  ).body;
  const q = () => ({
    id: randomUUID(),
    source: 'ask_user',
    questionId: randomUUID(),
    toolCallId: 'original-ask',
    method: 'input',
    title: 'Which files?',
    message: 'Choose the required scope',
    status: 'pending',
  });
  function original(extra = {}, question = q()) {
    const p = {
      id: randomUUID(),
      conversationId: randomUUID(),
      input: 'Original work must not run a second time',
      projectId: 'alpha',
      access: 'edit',
      thinkingLevel: 'high',
      attachments: [],
      mode: 'queue',
      ...extra,
    };
    const state = {
      status: extra.status || 'interrupted',
      createdAt: new Date().toISOString(),
      revision: 1,
      output: 'Saved progress',
      thinking: '',
      tools: [],
      uiRequests: [question],
    };
    app.store.db
      .prepare('INSERT INTO pi_tasks(owner,id,conversation_id,payload,state) VALUES(?,?,?,?,?)')
      .run(owner.user.id, p.id, p.conversationId, JSON.stringify(p), JSON.stringify(state));
    return { ...p, q: question };
  }
  const a = original(),
    path = '/pi/tasks/' + a.id + '/question-resume',
    answer = { id: a.q.id, value: 'Only the README' };
  assert.equal((await req(path, answer, other.token)).status, 404);
  assert.equal((await req(path, { ...answer, confirmed: true }, owner.token)).status, 400);
  const first = await req(path, answer, owner.token);
  assert.equal(first.status, 202, JSON.stringify(first.body));
  assert.notEqual(first.body.task.id, a.id);
  assert.equal(first.body.task.input, answer.value);
  assert.equal(first.body.task.projectId, a.projectId);
  assert.equal(first.body.task.access, a.access);
  assert.equal(first.body.task.thinkingLevel, a.thinkingLevel);
  assert.equal(first.body.task.resumeQuestion.previousTaskId, a.id);
  assert.equal(cancels[0].requestId, a.id);
  for (let i = 0; i < 100 && !runs.length; i++)
    await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(runs.length, 1);
  assert.equal(runs[0].requestId, first.body.task.id);
  assert.equal(runs[0].input, answer.value);
  assert.equal(runs[0].resumeQuestion.questionId, a.q.questionId);
  assert.equal((await req(path, answer, owner.token)).body.task.id, first.body.task.id);
  assert.equal((await req(path, { ...answer, value: 'Different' }, owner.token)).status, 409);
  const prior = JSON.parse(
    app.store.db.prepare('SELECT state FROM pi_tasks WHERE id=?').get(a.id).state,
  );
  assert.equal(prior.status, 'interrupted');
  assert.equal(prior.uiRequests[0].status, 'resolved');
  const denied = original();
  writable = false;
  assert.equal(
    (
      await req(
        '/pi/tasks/' + denied.id + '/question-resume',
        { id: denied.q.id, value: 'continue' },
        owner.token,
      )
    ).status,
    403,
  );
  writable = true;
  for (const extra of [{ status: 'cancelled' }, { assistance: 'selection' }]) {
    const p = original(extra);
    assert.equal(
      (
        await req(
          '/pi/tasks/' + p.id + '/question-resume',
          { id: p.q.id, value: 'continue' },
          owner.token,
        )
      ).status,
      409,
    );
  }
  const native = original({}, { ...q(), method: 'confirm' });
  assert.equal(
    (
      await req(
        '/pi/tasks/' + native.id + '/question-resume',
        { id: native.q.id, value: 'yes' },
        owner.token,
      )
    ).status,
    409,
  );
  const deleted = original();
  app.store.db
    .prepare('INSERT INTO pi_closed_conversations VALUES(?,?)')
    .run(owner.user.id, deleted.conversationId);
  assert.equal(
    (
      await req(
        '/pi/tasks/' + deleted.id + '/question-resume',
        { id: deleted.q.id, value: 'continue' },
        owner.token,
      )
    ).status,
    409,
  );
  assert.equal(
    JSON.parse(app.store.db.prepare('SELECT state FROM pi_tasks WHERE id=?').get(deleted.id).state)
      .uiRequests[0].status,
    'pending',
  );
  assert.equal(
    app.store.db
      .prepare(
        "SELECT count(*) n FROM pi_tasks WHERE json_extract(payload,'$.resumeQuestion') IS NOT NULL",
      )
      .get().n,
    1,
  );
});
