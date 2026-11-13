import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/index.mjs';

async function fixture(t, controls = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'astral-helper-context-')),
    admin = 'synthetic-helper-admin-token-123456789';
  const runs = [];
  const deletions = [];
  let projectAllowed = true;
  const app = await createApp({
    token: admin,
    dataDir: dir,
    piConcurrency: 1,
    now: controls.now,
    temporaryChatSweepMs: controls.sweepMs,
    piConfig: {
      url: 'http://synthetic-pi',
      token: 'synthetic-only',
      fetch: async (url, options) => {
        if (url.endsWith('/health'))
          return Response.json({ ready: true, nativeSessions: controls.nativeSessions ?? false });
        if (url.endsWith('/sessions/delete')) {
          const payload = JSON.parse(options.body);
          deletions.push(payload);
          const result = await controls.deleteSession?.(payload);
          return result || Response.json({ ok: true });
        }
        if (/\/sessions\/(inspect|compact|context)$/.test(url)) {
          const result = await controls.nativeOperation?.(url, JSON.parse(options.body));
          return result || Response.json({ context: { messageCount: 0 } });
        }
        if (url.endsWith('/projects')) {
          await controls.projects?.();
          return Response.json({
            projects: projectAllowed ? [{ id: 'alpha', readOnly: true }] : [],
          });
        }
        if (url.endsWith('/schedules/pending')) return Response.json({ runs: [] });
        if (url.endsWith('/run/stream')) {
          runs.push(JSON.parse(options.body));
          await controls.run?.(runs.at(-1));
          return new Response(
            JSON.stringify({ type: 'done', output: 'Read-only explanation', tools: [] }) + '\n',
            { headers: { 'Content-Type': 'application/x-ndjson' } },
          );
        }
        return Response.json({});
      },
    },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  };
  t.after(async () => {
    await close();
    await rm(dir, { recursive: true, force: true });
  });
  const req = async (path, data, token, method) => {
    const res = await fetch('http://127.0.0.1:' + app.server.address().port + '/api' + path, {
      method: method || (data ? 'POST' : 'GET'),
      headers: {
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(data ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    return { status: res.status, body: await res.json() };
  };
  const owner = (
    await req('/auth/bootstrap', {
      username: 'helperowner',
      password: 'Synthetic-helper-password',
      displayName: 'Owner',
      adminToken: admin,
    })
  ).body;
  const invite = (await req('/auth/invitations', {}, owner.token)).body;
  const other = (
    await req('/auth/register', {
      username: 'helperother',
      password: 'Synthetic-helper-password',
      displayName: 'Other',
      invite: invite.code,
    })
  ).body;
  function parent(
    actor = owner,
    input = 'Parent background about RRF',
    output = 'RRF means reciprocal rank fusion',
    project = null,
  ) {
    const id = randomUUID(),
      task = randomUUID();
    app.store.db
      .prepare(
        'INSERT INTO pi_conversations(owner,id,project_id,access,created_at,updated_at) VALUES(?,?,?,?,?,?)',
      )
      .run(actor.user.id, id, project, 'read', '2026-11-12T00:00:00Z', '2026-11-12T00:00:00Z');
    app.store.db
      .prepare(
        'INSERT INTO pi_turns(owner,id,conversation_id,input,output,project_id,created_at) VALUES(?,?,?,?,?,?,?)',
      )
      .run(actor.user.id, task, id, input, output, project, '2026-11-12T00:00:00Z');
    return id;
  }
  return {
    app,
    close,
    req,
    owner,
    other,
    parent,
    runs,
    deletions,
    revokeProject: () => {
      projectAllowed = false;
    },
  };
}
const waitTask = async (f, id) => {
  for (let n = 0; n < 80; n++) {
    const value = await f.req('/pi/tasks', undefined, f.owner.token);
    const task = value.body.tasks?.find((task) => task.id === id);
    if (['done', 'error'].includes(task?.status)) return task;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw Error('Synthetic helper task did not settle');
};

test('HTTP temporary helpers use owned parent context, preserve native isolation and retries, and reject source substitution', async (t) => {
  const f = await fixture(t),
    source = { origin: 'server', id: f.parent() },
    temp = randomUUID(),
    id = randomUUID();
  const payload = {
    id,
    conversationId: temp,
    kind: 'selection',
    input: 'Explain the selected term',
    source,
  };
  assert.equal((await f.req('/pi/assist', payload)).status, 401);
  assert.equal((await f.req('/pi/assist', payload, f.other.token)).status, 404);
  assert.equal(
    (await f.req('/pi/assist', { ...payload, owner: f.other.user.id }, f.owner.token)).status,
    400,
  );
  assert.equal(
    (await f.req('/pi/assist', { ...payload, kind: 'mail' }, f.owner.token)).status,
    400,
  );
  const accepted = await f.req('/pi/assist', payload, f.owner.token);
  assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
  const task = await waitTask(f, id);
  assert.equal(task.status, 'done', JSON.stringify(task));
  assert.equal(f.runs.length, 1);
  const run = f.runs[0];
  assert.match(run.input, /Parent background about RRF/);
  assert.match(run.input, /reciprocal rank fusion/);
  assert.ok(run.input.endsWith(payload.input));
  assert.deepEqual(run.toolAllowlist, []);
  assert.equal(run.canManageSkills, false);
  for (const field of ['appAccess', 'hostAccess', 'mailAccess', 'sandboxAccess', 'goalAccess'])
    assert.equal(run[field], undefined);
  assert.equal(run.projectId, undefined);
  assert.deepEqual(run.history, []);
  const original = f.app.store.db
    .prepare('SELECT output FROM pi_turns WHERE owner=? AND conversation_id=?')
    .get(f.owner.user.id, source.id);
  assert.equal(original.output, 'RRF means reciprocal rank fusion');
  f.app.store.db
    .prepare(
      'INSERT INTO pi_turns(owner,id,conversation_id,input,output,created_at) VALUES(?,?,?,?,?,?)',
    )
    .run(
      f.owner.user.id,
      randomUUID(),
      source.id,
      'A newer message',
      'A newer answer',
      '2026-11-12T00:01:00Z',
    );
  assert.equal((await f.req('/pi/assist', payload, f.owner.token)).status, 202);
  assert.equal(
    f.runs.length,
    1,
    'retry must return the accepted task rather than re-run with refreshed parent context',
  );
  const next = { ...payload, id: randomUUID(), input: 'What about the new answer?' };
  assert.equal((await f.req('/pi/assist', next, f.owner.token)).status, 202);
  assert.equal((await waitTask(f, next.id)).status, 'done');
  assert.match(f.runs[1].input, /A newer answer/);
  const otherSource = { origin: 'server', id: f.parent(f.owner, 'Different parent') };
  assert.equal(
    (
      await f.req(
        '/pi/assist',
        { ...payload, id: randomUUID(), source: otherSource },
        f.owner.token,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await f.req(
        '/pi/assist',
        { ...payload, id: randomUUID(), source: { origin: 'server', id: temp } },
        f.owner.token,
      )
    ).status,
    400,
  );
  const noSource = {
    id: randomUUID(),
    conversationId: randomUUID(),
    kind: 'selection',
    input: 'Legacy isolated helper',
  };
  assert.equal((await f.req('/pi/assist', noSource, f.owner.token)).status, 202);
  assert.equal((await waitTask(f, noSource.id)).status, 'done');
  assert.equal(f.runs.at(-1).input, noSource.input);
});

test('temporary helpers recheck parent project authorization and do not replay the parent', async (t) => {
  const f = await fixture(t),
    source = { origin: 'server', id: f.parent(f.owner, 'Scoped parent', 'Scoped answer', 'alpha') };
  const payload = {
    id: randomUUID(),
    conversationId: randomUUID(),
    kind: 'selection',
    input: 'Explain it',
    source,
  };
  const accepted = await f.req('/pi/assist', payload, f.owner.token);
  assert.equal(accepted.status, 202);
  f.revokeProject();
  const task = await waitTask(f, payload.id);
  // The acceptance race may legitimately start the task immediately. Test the
  // second, already-revoked submission as a deterministic authorization check.
  const denied = await f.req('/pi/assist', { ...payload, id: randomUUID() }, f.owner.token);
  assert.equal(denied.status, 404);
  assert.ok(f.runs.length <= 1);
  assert.ok(['done', 'error'].includes(task.status));
  assert.equal(
    f.app.store.db
      .prepare('SELECT COUNT(*) n FROM pi_turns WHERE owner=? AND conversation_id=?')
      .get(f.owner.user.id, source.id).n,
    1,
  );
});

test('queued helper uses the edited question and latest parent prose when execution begins', async (t) => {
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const f = await fixture(t, {
    run: (run) => (run.input === 'Hold the queue' ? blocked : undefined),
  });
  const blocker = {
    id: randomUUID(),
    conversationId: randomUUID(),
    kind: 'selection',
    input: 'Hold the queue',
  };
  assert.equal((await f.req('/pi/assist', blocker, f.owner.token)).status, 202);
  for (let n = 0; !f.runs.length && n < 80; n++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(f.runs.length, 1);
  const source = { origin: 'server', id: f.parent() };
  const payload = {
    id: randomUUID(),
    conversationId: randomUUID(),
    kind: 'selection',
    input: 'OLD-QUESTION',
    source,
  };
  const queued = await f.req('/pi/assist', payload, f.owner.token);
  assert.equal(queued.status, 202);
  assert.equal(queued.body.task.status, 'queued');
  assert.equal(
    (
      await f.req(
        '/pi/tasks/' + payload.id,
        {
          input: 'EDITED-QUESTION',
          revision: queued.body.task.revision,
        },
        f.owner.token,
        'PATCH',
      )
    ).status,
    200,
  );
  f.app.store.db
    .prepare(
      'INSERT INTO pi_turns(owner,id,conversation_id,input,output,created_at) VALUES(?,?,?,?,?,?)',
    )
    .run(
      f.owner.user.id,
      randomUUID(),
      source.id,
      'Fresh parent question',
      'FRESH-PARENT-ANSWER',
      '2026-11-12T00:02:00Z',
    );
  release();
  assert.equal((await waitTask(f, payload.id)).status, 'done');
  assert.equal(f.runs.length, 2);
  assert.ok(f.runs[1].input.endsWith('EDITED-QUESTION'));
  assert.match(f.runs[1].input, /FRESH-PARENT-ANSWER/);
  assert.doesNotMatch(f.runs[1].input, /OLD-QUESTION/);
});

test('queued helpers reject deleted parents and revoked projects before any model request', async (t) => {
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const f = await fixture(t, {
    run: (run) => (run.input === 'Hold for revocation' ? blocked : undefined),
  });
  const blocker = {
    id: randomUUID(),
    conversationId: randomUUID(),
    kind: 'selection',
    input: 'Hold for revocation',
  };
  assert.equal((await f.req('/pi/assist', blocker, f.owner.token)).status, 202);
  for (let n = 0; !f.runs.length && n < 80; n++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(f.runs.length, 1);
  const sources = [f.parent(f.owner, 'Scoped parent', 'Scoped answer', 'alpha'), f.parent()];
  const queued = sources.map((id) => ({
    id: randomUUID(),
    conversationId: randomUUID(),
    kind: 'selection',
    input: 'Explain after the queue',
    source: { origin: 'server', id },
  }));
  for (const payload of queued) {
    const response = await f.req('/pi/assist', payload, f.owner.token);
    assert.equal(response.status, 202);
    assert.equal(response.body.task.status, 'queued');
  }
  f.revokeProject();
  f.app.store.db
    .prepare('INSERT INTO pi_closed_conversations VALUES(?,?)')
    .run(f.owner.user.id, sources[1]);
  release();
  for (const payload of queued) assert.equal((await waitTask(f, payload.id)).status, 'error');
  assert.equal(f.runs.length, 1, 'invalid parent context must never reach the model');
  for (const id of sources) {
    assert.equal(
      f.app.store.db
        .prepare('SELECT COUNT(*) n FROM pi_turns WHERE owner=? AND conversation_id=?')
        .get(f.owner.user.id, id).n,
      1,
    );
  }
});

test('concurrent first submissions cannot bind one helper to different main chats', async (t) => {
  let release,
    arrived = 0;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const f = await fixture(t, {
    projects: async () => {
      if (++arrived <= 2) {
        if (arrived === 2) release();
        await barrier;
      }
    },
  });
  const conversationId = randomUUID();
  const attempts = ['FIRST', 'SECOND'].map((input) => ({
    id: randomUUID(),
    conversationId,
    kind: 'selection',
    input,
    source: { origin: 'server', id: f.parent(f.owner, input, input + ' answer', 'alpha') },
  }));
  const responses = await Promise.all(
    attempts.map((payload) => f.req('/pi/assist', payload, f.owner.token)),
  );
  assert.deepEqual(responses.map((r) => r.status).sort(), [202, 409]);
  const accepted = responses.findIndex((r) => r.status === 202);
  const binding = f.app.store.db
    .prepare('SELECT source FROM pi_assistance_sources WHERE owner=? AND id=?')
    .get(f.owner.user.id, conversationId);
  assert.deepEqual(JSON.parse(binding.source), attempts[accepted].source);
  assert.equal(
    f.app.store.db
      .prepare('SELECT COUNT(*) n FROM pi_tasks WHERE owner=? AND conversation_id=?')
      .get(f.owner.user.id, conversationId).n,
    1,
  );
});

test('concurrent retries return the same accepted helper rather than rejecting or replaying it', async (t) => {
  let release,
    arrived = 0;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const f = await fixture(t, {
    projects: async () => {
      if (++arrived <= 2) {
        if (arrived === 2) release();
        await barrier;
      }
    },
  });
  const payload = {
    id: randomUUID(),
    conversationId: randomUUID(),
    kind: 'selection',
    input: 'Same question',
    source: { origin: 'server', id: f.parent(f.owner, 'Scoped parent', 'Scoped answer', 'alpha') },
  };
  const responses = await Promise.all([
    f.req('/pi/assist', payload, f.owner.token),
    f.req('/pi/assist', payload, f.owner.token),
  ]);
  assert.deepEqual(
    responses.map((r) => r.status),
    [202, 202],
  );
  assert.equal(responses[0].body.task.id, responses[1].body.task.id);
  assert.equal((await waitTask(f, payload.id)).status, 'done');
  assert.equal(f.runs.length, 1);
});

test('unified navigation keeps explicitly saved helpers and removes deleted single Pi histories', async (t) => {
  const f = await fixture(t),
    parent = f.parent(),
    helper = randomUUID(),
    task = randomUUID();
  const accepted = await f.req(
    '/pi/assist',
    {
      id: task,
      conversationId: helper,
      input: 'Explain',
      kind: 'selection',
      source: { origin: 'server', id: parent },
    },
    f.owner.token,
  );
  assert.equal(accepted.status, 202);
  assert.equal((await waitTask(f, task)).status, 'done');
  let directory = await f.req('/assistant/conversations', undefined, f.owner.token);
  assert.equal(directory.status, 200);
  assert(!directory.body.conversations.some((c) => c.active.nativeId === helper));
  assert.equal(
    (await f.req('/pi/conversations/' + helper, { archived: false }, f.owner.token, 'PATCH'))
      .status,
    200,
  );
  directory = await f.req('/assistant/conversations', undefined, f.owner.token);
  assert(directory.body.conversations.some((c) => c.active.nativeId === helper));
  const display = directory.body.conversations.find((c) => c.active.nativeId === parent);
  assert.equal(
    (await f.req('/assistant/conversations/' + display.id, undefined, f.other.token, 'DELETE'))
      .status,
    404,
  );
  assert.equal(
    (await f.req('/assistant/conversations/' + display.id, undefined, f.owner.token, 'DELETE'))
      .status,
    200,
  );
  directory = await f.req('/assistant/conversations', undefined, f.owner.token);
  assert(!directory.body.conversations.some((c) => c.segments.some((s) => s.nativeId === parent)));
  assert.equal(
    f.app.store.db
      .prepare('SELECT count(*) n FROM pi_turns WHERE owner=? AND conversation_id=?')
      .get(f.owner.user.id, parent).n,
    0,
  );
  const another = f.parent();
  await f.req('/assistant/conversations', undefined, f.owner.token);
  assert.equal(
    (await f.req('/pi/conversations/' + another, undefined, f.owner.token, 'DELETE')).status,
    200,
  );
  assert(
    !(await f.req('/assistant/conversations', undefined, f.owner.token)).body.conversations.some(
      (c) => c.active.nativeId === another,
    ),
  );
});

test('selection side chat reopens the same parent helper with its original history and separate parents stay isolated', async (t) => {
  const f = await fixture(t),
    source = { origin: 'server', id: f.parent() };
  const open = () => f.req('/pi/assist/session', { source }, f.owner.token);
  assert.equal((await f.req('/pi/assist/session', { source }, f.other.token)).status, 404);
  const first = await open();
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const { conversationId, source: boundSource } = first.body;
  assert.deepEqual(boundSource, source);
  assert.deepEqual(first.body.turns, []);
  const request = {
    id: randomUUID(),
    conversationId,
    source: boundSource,
    input: 'Remember this side question',
    kind: 'selection',
  };
  assert.equal((await f.req('/pi/assist', request, f.owner.token)).status, 202);
  assert.equal((await waitTask(f, request.id)).status, 'done');
  const reopened = await open();
  assert.equal(reopened.status, 200);
  assert.equal(reopened.body.conversationId, conversationId);
  assert.equal(reopened.body.turns[0].input, request.input);
  assert.equal(reopened.body.turns[0].output, 'Read-only explanation');
  assert.equal(reopened.body.tasks[0].id, request.id);
  const next = { ...request, id: randomUUID(), input: 'Continue the previous side answer' };
  assert.equal((await f.req('/pi/assist', next, f.owner.token)).status, 202);
  assert.equal((await waitTask(f, next.id)).status, 'done');
  assert.deepEqual(
    f.runs[1].history.map((m) => m.content),
    [request.input, 'Read-only explanation'],
  );
  assert.equal(f.runs[1].sessionKey, f.runs[0].sessionKey);
  assert.deepEqual(f.runs[1].toolAllowlist, []);
  const second = await f.req(
    '/pi/assist/session',
    { source: { origin: 'server', id: f.parent() } },
    f.owner.token,
  );
  assert.equal(second.status, 200);
  assert.notEqual(second.body.conversationId, conversationId);
  assert.deepEqual(second.body.turns, []);
  assert.equal(f.runs.length, 2, 'opening does not submit or replay any task');
});

test('selection helper identity follows a unified main conversation across immutable native segments', async (t) => {
  const f = await fixture(t),
    first = f.parent(),
    next = f.parent(),
    display = randomUUID();
  for (const [ordinal, nativeId] of [first, next].entries()) {
    f.app.store.db
      .prepare(
        'INSERT INTO assistant_segments(owner,display_id,ordinal,origin,native_id,runtime) VALUES(?,?,?,?,?,?)',
      )
      .run(f.owner.user.id, display, ordinal, 'server', nativeId, '{}');
  }
  const open = (id) =>
    f.req('/pi/assist/session', { source: { origin: 'server', id } }, f.owner.token);
  const original = await open(first),
    switched = await open(next);
  assert.equal(original.status, 200, JSON.stringify(original.body));
  assert.equal(switched.status, 200, JSON.stringify(switched.body));
  assert.equal(original.body.conversationId, switched.body.conversationId);
  assert.deepEqual(switched.body.source, { origin: 'server', id: first });
  const task = {
    id: randomUUID(),
    conversationId: switched.body.conversationId,
    source: switched.body.source,
    kind: 'selection',
    input: 'Explain the continuation',
  };
  assert.equal((await f.req('/pi/assist', task, f.owner.token)).status, 202);
  assert.equal((await waitTask(f, task.id)).status, 'done');
  assert.equal((await open(next)).body.turns[0].id, task.id);
});

test('reopening a side chat rechecks revoked parent access without replaying its previous task', async (t) => {
  const f = await fixture(t);
  const source = {
    origin: 'server',
    id: f.parent(f.owner, 'Scoped main', 'Scoped answer', 'alpha'),
  };
  const opened = await f.req('/pi/assist/session', { source }, f.owner.token);
  assert.equal(opened.status, 200);
  const payload = {
    id: randomUUID(),
    conversationId: opened.body.conversationId,
    source,
    kind: 'selection',
    input: 'Explain the scoped answer',
  };
  assert.equal((await f.req('/pi/assist', payload, f.owner.token)).status, 202);
  assert.equal((await waitTask(f, payload.id)).status, 'done');
  f.revokeProject();
  assert.equal((await f.req('/pi/assist/session', { source }, f.owner.token)).status, 404);
  assert.equal(f.runs.length, 1);
});

test('concurrent side-chat openings reserve one helper and unified indexing retains an unused reservation', async (t) => {
  let arrived = 0,
    release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const f = await fixture(t, {
    projects: async () => {
      if (++arrived <= 2) {
        if (arrived === 2) release();
        await barrier;
      }
    },
  });
  const source = { origin: 'server', id: f.parent(f.owner, 'Scoped main', 'Answer', 'alpha') };
  const responses = await Promise.all(
    Array.from({ length: 2 }, () => f.req('/pi/assist/session', { source }, f.owner.token)),
  );
  assert.deepEqual(
    responses.map((r) => r.status),
    [200, 200],
  );
  assert.equal(responses[0].body.conversationId, responses[1].body.conversationId);
  await f.req('/assistant/conversations', undefined, f.owner.token);
  const indexed = await f.req('/pi/assist/session', { source }, f.owner.token);
  assert.equal(indexed.status, 200);
  assert.equal(indexed.body.conversationId, responses[0].body.conversationId);
  assert.equal(f.runs.length, 0);
});

test('older selection helpers migrate to their parent binding and deleted helpers are replaced without replay', async (t) => {
  const f = await fixture(t),
    source = { origin: 'server', id: f.parent() },
    helper = randomUUID();
  const payload = {
    id: randomUUID(),
    conversationId: helper,
    source,
    kind: 'selection',
    input: 'Existing side question',
  };
  assert.equal((await f.req('/pi/assist', payload, f.owner.token)).status, 202);
  assert.equal((await waitTask(f, payload.id)).status, 'done');
  const restored = await f.req('/pi/assist/session', { source }, f.owner.token);
  assert.equal(restored.status, 200);
  assert.equal(restored.body.conversationId, helper);
  assert.equal(restored.body.turns[0].input, payload.input);
  assert.equal(
    (await f.req('/pi/conversations/' + helper, undefined, f.owner.token, 'DELETE')).status,
    200,
  );
  const replacement = await f.req('/pi/assist/session', { source }, f.owner.token);
  assert.equal(replacement.status, 200);
  assert.notEqual(replacement.body.conversationId, helper);
  assert.deepEqual(replacement.body.turns, []);
  assert.deepEqual(replacement.body.tasks, []);
  assert.equal(f.runs.length, 1);
});

test('an opened but unused side-chat reservation cannot be rebound to a different parent or helper purpose', async (t) => {
  const f = await fixture(t),
    source = { origin: 'server', id: f.parent() };
  const opened = await f.req('/pi/assist/session', { source }, f.owner.token);
  assert.equal(opened.status, 200);
  const payload = {
    id: randomUUID(),
    conversationId: opened.body.conversationId,
    input: 'Explain',
    kind: 'selection',
    source: { origin: 'server', id: f.parent() },
  };
  assert.equal((await f.req('/pi/assist', payload, f.owner.token)).status, 409);
  assert.equal(
    (
      await f.req(
        '/pi/assist',
        {
          id: randomUUID(),
          conversationId: opened.body.conversationId,
          input: 'Mail',
          kind: 'mail',
        },
        f.owner.token,
      )
    ).status,
    409,
  );
  assert.equal(f.runs.length, 0);
  assert.equal(
    (await f.req('/pi/assist', { ...payload, id: randomUUID(), source }, f.owner.token)).status,
    202,
  );
});

test('side-chat parent binding survives an application restart without submitting a new model request', async (t) => {
  const f = await fixture(t),
    source = { origin: 'server', id: f.parent() };
  const opened = await f.req('/pi/assist/session', { source }, f.owner.token);
  assert.equal(opened.status, 200);
  const payload = {
    id: randomUUID(),
    conversationId: opened.body.conversationId,
    source,
    kind: 'selection',
    input: 'Retain this side context',
  };
  assert.equal((await f.req('/pi/assist', payload, f.owner.token)).status, 202);
  assert.equal((await waitTask(f, payload.id)).status, 'done');
  const file = f.app.store.db.prepare('PRAGMA database_list').get().file;
  await f.close();
  const restored = await createApp({
    token: 'synthetic-helper-admin-token-123456789',
    dataDir: file.slice(0, file.lastIndexOf('/')),
  });
  await new Promise((resolve) => restored.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    restored.server.closeAllConnections();
    await new Promise((resolve) => restored.server.close(resolve));
  });
  const response = await fetch(
    'http://127.0.0.1:' + restored.server.address().port + '/api/pi/assist/session',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + f.owner.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ source }),
    },
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.conversationId, opened.body.conversationId);
  assert.equal(body.turns[0].input, payload.input);
  assert.equal(body.tasks[0].id, payload.id);
  assert.equal(f.runs.length, 1);
});

const hour = 3600000;
const openedHelper = async (f, source) => {
  const opened = await f.req('/pi/assist/session', { source }, f.owner.token);
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  return opened.body;
};
const sendHelper = async (f, session, input = 'A temporary question') => {
  const payload = {
    id: randomUUID(),
    conversationId: session.conversationId,
    source: session.source,
    kind: 'selection',
    input,
  };
  const result = await f.req('/pi/assist', payload, f.owner.token);
  assert.equal(result.status, 202, JSON.stringify(result.body));
  assert.equal((await waitTask(f, payload.id)).status, 'done');
  return payload;
};

test('side-chat lifetime defaults to one idle hour and destroys native plus local history without replay', async (t) => {
  let time = Date.now();
  const f = await fixture(t, { now: () => time, nativeSessions: true });
  const source = { origin: 'server', id: f.parent() };
  const session = await openedHelper(f, source);
  assert.equal(session.ttlHours, 1);
  assert.equal(session.expiresAt, time + hour);
  assert.equal(session.saved, false);
  const payload = await sendHelper(f, session);
  time += hour + 1;
  const next = await openedHelper(f, source);
  assert.notEqual(next.conversationId, session.conversationId);
  assert(next.expiredConversationIds.includes(session.conversationId));
  assert.deepEqual(next.turns, []);
  assert.deepEqual(next.tasks, []);
  assert.equal(f.deletions.length, 1);
  assert.equal(f.deletions[0].sessionKey, f.runs[0].sessionKey);
  for (const [table, idColumn] of [
    ['pi_turns', 'conversation_id'],
    ['pi_tasks', 'conversation_id'],
    ['pi_assistance_sources', 'id'],
    ['pi_assistance_conversations', 'id'],
    ['pi_assistance_lifetimes', 'id'],
    ['pi_conversations', 'id'],
    ['agent_conversation_bindings', 'conversation_id'],
  ])
    assert.equal(
      f.app.store.db
        .prepare(`SELECT count(*) n FROM ${table} WHERE owner=? AND ${idColumn}=?`)
        .get(f.owner.user.id, session.conversationId).n,
      0,
      table,
    );
  assert(
    f.app.store.db
      .prepare('SELECT 1 FROM pi_closed_conversations WHERE owner=? AND conversation_id=?')
      .get(f.owner.user.id, session.conversationId),
  );
  assert.equal((await f.req('/pi/assist', payload, f.owner.token)).status, 409);
  assert.equal(f.runs.length, 1);
  assert.equal(
    f.app.store.db
      .prepare('SELECT count(*) n FROM pi_turns WHERE owner=? AND conversation_id=?')
      .get(f.owner.user.id, source.id).n,
    1,
  );
  const list = await f.req('/assistant/conversations', undefined, f.owner.token);
  assert(!list.body.conversations.some((c) => c.active.nativeId === session.conversationId));
});

test('owned lifetime preferences accept longer windows, persist across helpers, and reject unauthorized or malformed changes', async (t) => {
  let time = Date.now();
  const f = await fixture(t, { now: () => time, nativeSessions: true });
  const source = { origin: 'server', id: f.parent() };
  const session = await openedHelper(f, source);
  assert.equal(
    (await f.req('/pi/assist/preferences', { source, ttlHours: 6 }, f.other.token, 'PATCH')).status,
    404,
  );
  for (const ttlHours of [0, 2, 40, '6', 1.5, null])
    assert.equal(
      (await f.req('/pi/assist/preferences', { source, ttlHours }, f.owner.token, 'PATCH')).status,
      400,
    );
  assert.equal(
    (
      await f.req(
        '/pi/assist/preferences',
        { source, ttlHours: 6, owner: f.other.user.id },
        f.owner.token,
        'PATCH',
      )
    ).status,
    400,
  );
  for (const ttlHours of [6, 24, 168]) {
    const changed = await f.req(
      '/pi/assist/preferences',
      { source, ttlHours },
      f.owner.token,
      'PATCH',
    );
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.ttlHours, ttlHours);
    assert.equal(changed.body.expiresAt, time + ttlHours * hour);
  }
  await sendHelper(f, session);
  time += 24 * hour;
  const reopened = await openedHelper(f, source);
  assert.equal(reopened.conversationId, session.conversationId);
  assert.equal(reopened.ttlHours, 168);
  assert.equal(reopened.expiresAt, time + 168 * hour);
  time += 168 * hour + 1;
  const next = await openedHelper(f, source);
  assert.notEqual(next.conversationId, session.conversationId);
  assert.equal(next.ttlHours, 168);
  assert.equal(f.runs.length, 1);
});

test('changing lifetime renews a native helper after unified indexing without reopening or reserving another helper', async (t) => {
  let time = Date.now();
  const f = await fixture(t, { now: () => time, nativeSessions: true });
  const first = f.parent(),
    next = f.parent(),
    source = { origin: 'server', id: first },
    session = await openedHelper(f, source),
    display = randomUUID();
  time += 45 * 60000;
  for (const [ordinal, nativeId] of [first, next].entries())
    f.app.store.db
      .prepare(
        'INSERT INTO assistant_segments(owner,display_id,ordinal,origin,native_id,runtime) VALUES(?,?,?,?,?,?)',
      )
      .run(f.owner.user.id, display, ordinal, 'server', nativeId, '{}');
  const changed = await f.req(
    '/pi/assist/preferences',
    { source: { origin: 'server', id: next }, ttlHours: 6 },
    f.owner.token,
    'PATCH',
  );
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(changed.body.expiresAt, time + 6 * hour);
  assert.equal(
    f.app.store.db
      .prepare('SELECT last_active FROM pi_assistance_lifetimes WHERE owner=? AND id=?')
      .get(f.owner.user.id, session.conversationId).last_active,
    time,
  );
  assert.equal(
    f.app.store.db
      .prepare('SELECT count(DISTINCT id) n FROM pi_assistance_parents WHERE owner=?')
      .get(f.owner.user.id).n,
    1,
  );
  const status = await f.req('/pi/assist/preferences', { source }, f.owner.token);
  assert.equal(status.status, 200, JSON.stringify(status.body));
  assert.equal(status.body.conversationId, session.conversationId);
  assert.equal(status.body.ttlHours, 6);
  assert.equal(status.body.expiresAt, time + 6 * hour);
  assert.equal(f.runs.length, 0);
  assert.equal(f.deletions.length, 0);
});

test('opening and sending renew idle lifetime while background polling never renews it', async (t) => {
  let time = Date.now();
  const f = await fixture(t, { now: () => time, nativeSessions: true });
  const source = { origin: 'server', id: f.parent() };
  const session = await openedHelper(f, source);
  time += 45 * 60000;
  assert.equal((await openedHelper(f, source)).expiresAt, time + hour);
  time += 45 * 60000;
  const payload = await sendHelper(f, session);
  const active = f.app.store.db
    .prepare('SELECT last_active FROM pi_assistance_lifetimes WHERE owner=? AND id=?')
    .get(f.owner.user.id, session.conversationId).last_active;
  assert.equal(active, time);
  time += 45 * 60000;
  await f.req('/pi/tasks', undefined, f.owner.token);
  await f.req('/pi/conversations/' + session.conversationId, undefined, f.owner.token);
  assert.equal(
    f.app.store.db
      .prepare('SELECT last_active FROM pi_assistance_lifetimes WHERE owner=? AND id=?')
      .get(f.owner.user.id, session.conversationId).last_active,
    active,
  );
  time += 16 * 60000;
  assert.notEqual((await openedHelper(f, source)).conversationId, session.conversationId);
  assert.equal(f.runs[0].requestId, payload.id);
});

test('expired histories remain intact until native session deletion is explicitly acknowledged', async (t) => {
  let time = Date.now(),
    failDelete = true;
  const f = await fixture(t, {
    now: () => time,
    nativeSessions: true,
    deleteSession: () =>
      failDelete ? Response.json({ error: 'Synthetic unavailable' }, { status: 503 }) : undefined,
  });
  const source = { origin: 'server', id: f.parent() };
  const session = await openedHelper(f, source);
  await sendHelper(f, session);
  time += hour + 1;
  const failed = await f.req('/pi/assist/session', { source }, f.owner.token);
  assert.equal(failed.status, 503);
  assert.equal(
    f.app.store.db
      .prepare('SELECT count(*) n FROM pi_turns WHERE owner=? AND conversation_id=?')
      .get(f.owner.user.id, session.conversationId).n,
    1,
  );
  assert.equal(
    f.app.store.db
      .prepare('SELECT count(*) n FROM pi_closed_conversations WHERE owner=? AND conversation_id=?')
      .get(f.owner.user.id, session.conversationId).n,
    0,
  );
  failDelete = false;
  assert.notEqual((await openedHelper(f, source)).conversationId, session.conversationId);
  assert.equal(f.runs.length, 1);
});

test('retaining a helper permanently exempts it from expiry even when it is later archived', async (t) => {
  let time = Date.now();
  const f = await fixture(t, { now: () => time, nativeSessions: true });
  const source = { origin: 'server', id: f.parent() };
  const session = await openedHelper(f, source);
  await sendHelper(f, session);
  assert.equal(
    (
      await f.req(
        '/pi/conversations/' + session.conversationId,
        { archived: false },
        f.owner.token,
        'PATCH',
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await f.req(
        '/pi/conversations/' + session.conversationId,
        { archived: true },
        f.owner.token,
        'PATCH',
      )
    ).status,
    200,
  );
  time += 500 * hour;
  const reopened = await openedHelper(f, source);
  assert.equal(reopened.conversationId, session.conversationId);
  assert.equal(reopened.saved, true);
  assert.equal(reopened.expiresAt, null);
  assert.equal(reopened.turns.length, 1);
  assert.equal(f.deletions.length, 0);
});

test('running, queued, stopping and unknown-result helpers cannot expire', async (t) => {
  let time = Date.now(),
    release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const f = await fixture(t, { now: () => time, nativeSessions: true, run: () => blocked });
  const source = { origin: 'server', id: f.parent() };
  const session = await openedHelper(f, source);
  const payload = {
    id: randomUUID(),
    conversationId: session.conversationId,
    source,
    kind: 'selection',
    input: 'A slow question',
  };
  assert.equal((await f.req('/pi/assist', payload, f.owner.token)).status, 202);
  for (let n = 0; !f.runs.length && n < 100; n++) await new Promise((r) => setTimeout(r, 5));
  time += 5 * hour;
  const reopened = await openedHelper(f, source);
  assert.equal(reopened.conversationId, session.conversationId);
  assert.equal(reopened.expiresAt, null);
  assert.equal(f.deletions.length, 0);
  release();
  assert.equal((await waitTask(f, payload.id)).status, 'done');
  assert.equal(
    f.app.store.db
      .prepare('SELECT last_active FROM pi_assistance_lifetimes WHERE owner=? AND id=?')
      .get(f.owner.user.id, session.conversationId).last_active,
    time,
  );
  for (const status of [
    'queued',
    'running',
    'stopping',
    'delivering',
    'accepted',
    'applied',
    'interrupted',
    'unknown',
  ]) {
    const id = randomUUID();
    f.app.store.db
      .prepare('INSERT INTO pi_tasks(owner,id,conversation_id,payload,state) VALUES(?,?,?,?,?)')
      .run(
        f.owner.user.id,
        id,
        session.conversationId,
        JSON.stringify({
          id,
          conversationId: session.conversationId,
          input: 'Unconfirmed',
          projectId: null,
          access: 'read',
          assistance: 'selection',
        }),
        JSON.stringify({ status }),
      );
    time += 2 * hour;
    assert.equal((await openedHelper(f, source)).conversationId, session.conversationId, status);
    assert.equal(f.deletions.length, 0, status);
    f.app.store.db.prepare('DELETE FROM pi_tasks WHERE owner=? AND id=?').run(f.owner.user.id, id);
  }
});

test('expiry waits for in-flight native operations and blocks recreating a destroyed helper', async (t) => {
  for (const action of ['inspect', 'compact', 'context'])
    await t.test(action, async (t) => {
      let time = Date.now(),
        release,
        arrived;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const entered = new Promise((resolve) => {
        arrived = resolve;
      });
      t.after(() => release());
      const f = await fixture(t, {
        now: () => time,
        nativeSessions: true,
        nativeOperation: async () => {
          arrived();
          await gate;
        },
      });
      const source = { origin: 'server', id: f.parent() };
      const session = await openedHelper(f, source);
      const pending = f.req(
        '/pi/conversations/' + session.conversationId + '/' + action,
        {},
        f.owner.token,
      );
      await Promise.race([
        entered,
        new Promise((_, reject) =>
          setTimeout(() => reject(Error('Native operation did not start')), 2000),
        ),
      ]);
      time += 2 * hour;
      const busy = await f.req('/pi/assist/preferences', { source }, f.owner.token);
      assert.equal(busy.status, 200, JSON.stringify(busy.body));
      assert.equal(busy.body.conversationId, session.conversationId);
      assert.equal(busy.body.expiresAt, null);
      assert.equal(f.deletions.length, 0);
      release();
      assert.equal((await pending).status, 200);
      const expired = await f.req('/pi/assist/preferences', { source }, f.owner.token);
      assert.equal(expired.status, 200, JSON.stringify(expired.body));
      assert.equal(expired.body.conversationId, null);
      assert.equal(f.deletions.length, 1);
      assert.equal(
        (await f.req('/pi/conversations/' + session.conversationId + '/context', {}, f.owner.token))
          .status,
        409,
      );
      assert.equal(
        (
          await f.req(
            '/pi/conversations/' + session.conversationId + '/files?name=late.txt',
            { data: 'Late upload' },
            f.owner.token,
          )
        ).status,
        409,
      );
      assert.equal(f.runs.length, 0);
    });
});

test('automatic expiry timer cleans idle helpers and is safe to close while native deletion is pending', async (t) => {
  let time = Date.now(),
    releaseDelete,
    enteredDelete;
  const entered = new Promise((resolve) => {
    enteredDelete = resolve;
  });
  const gate = new Promise((resolve) => {
    releaseDelete = resolve;
  });
  t.after(() => releaseDelete());
  const f = await fixture(t, {
    now: () => time,
    nativeSessions: true,
    sweepMs: 10,
    deleteSession: async () => {
      enteredDelete();
      await gate;
    },
  });
  const source = { origin: 'server', id: f.parent() };
  const session = await openedHelper(f, source);
  await sendHelper(f, session);
  time += hour + 1;
  await Promise.race([
    entered,
    new Promise((_, reject) => setTimeout(() => reject(Error('Expiry timer did not run')), 2000)),
  ]);
  assert.equal(f.deletions.length, 1);
  const rejected = await f.req(
    '/pi/assist',
    {
      id: randomUUID(),
      conversationId: session.conversationId,
      source,
      kind: 'selection',
      input: 'Racing send',
    },
    f.owner.token,
  );
  assert.equal(rejected.status, 409);
  assert.equal(
    (
      await f.req(
        '/pi/conversations/' + session.conversationId,
        { archived: false },
        f.owner.token,
        'PATCH',
      )
    ).status,
    409,
  );
  releaseDelete();
  for (
    let n = 0;
    n < 100 &&
    f.app.store.db
      .prepare('SELECT 1 FROM pi_assistance_lifetimes WHERE owner=? AND id=?')
      .get(f.owner.user.id, session.conversationId);
    n++
  )
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(
    f.app.store.db
      .prepare('SELECT 1 FROM pi_assistance_lifetimes WHERE owner=? AND id=?')
      .get(f.owner.user.id, session.conversationId),
    undefined,
  );
  await f.close();
  assert.equal(f.runs.length, 1);
});

test('side-chat lifetime setting survives restart and expired cleanup never resurrects an old helper', async (t) => {
  let time = Date.now();
  const f = await fixture(t, { now: () => time, nativeSessions: true });
  const source = { origin: 'server', id: f.parent() };
  const session = await openedHelper(f, source);
  await sendHelper(f, session);
  assert.equal(
    (await f.req('/pi/assist/preferences', { source, ttlHours: 6 }, f.owner.token, 'PATCH')).status,
    200,
  );
  const file = f.app.store.db.prepare('PRAGMA database_list').get().file;
  await f.close();
  time += 4 * hour;
  const deletions = [];
  const restored = await createApp({
    token: 'synthetic-helper-admin-token-123456789',
    dataDir: file.slice(0, file.lastIndexOf('/')),
    now: () => time,
    piConfig: {
      url: 'http://synthetic-pi',
      token: 'synthetic-only',
      fetch: async (url, options) => {
        if (url.endsWith('/health')) return Response.json({ ready: true, nativeSessions: true });
        if (url.endsWith('/sessions/delete')) {
          deletions.push(JSON.parse(options.body));
          return Response.json({ ok: true });
        }
        return Response.json({ runs: [] });
      },
    },
  });
  await new Promise((resolve) => restored.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    restored.server.closeAllConnections();
    await new Promise((resolve) => restored.server.close(resolve));
  });
  const open = async () => {
    const response = await fetch(
      'http://127.0.0.1:' + restored.server.address().port + '/api/pi/assist/session',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + f.owner.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ source }),
      },
    );
    assert.equal(response.status, 200);
    return response.json();
  };
  const recovered = await open();
  assert.equal(recovered.conversationId, session.conversationId);
  assert.equal(recovered.ttlHours, 6);
  assert.equal(recovered.turns.length, 1);
  assert.equal(recovered.expiresAt, time + 6 * hour);
  time += 6 * hour + 1;
  const next = await open();
  assert.notEqual(next.conversationId, session.conversationId);
  assert.equal(next.ttlHours, 6);
  assert(next.expiredConversationIds.includes(session.conversationId));
  assert.equal(deletions.length, 1);
  assert.equal(f.runs.length, 1);
});

test('closing application during expiry native deletion prevents any later local database access', async (t) => {
  let time = Date.now(),
    release,
    arrived;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const entered = new Promise((resolve) => {
    arrived = resolve;
  });
  t.after(() => release());
  const f = await fixture(t, {
    now: () => time,
    nativeSessions: true,
    sweepMs: 10,
    deleteSession: async () => {
      arrived();
      await gate;
    },
  });
  const source = { origin: 'server', id: f.parent() };
  const session = await openedHelper(f, source);
  await sendHelper(f, session);
  time += hour + 1;
  await Promise.race([
    entered,
    new Promise((_, reject) => setTimeout(() => reject(Error('No expiry request')), 2000)),
  ]);
  await f.close();
  release();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(f.deletions.length, 1);
  assert.equal(f.runs.length, 1);
});

test('lifetime status reads never renew or reserve helpers and confirm expiry before clients clear drafts', async (t) => {
  let time = Date.now();
  const f = await fixture(t, { now: () => time, nativeSessions: true });
  const source = { origin: 'server', id: f.parent() };
  const before = await f.req('/pi/assist/preferences', { source }, f.owner.token);
  assert.equal(before.status, 200);
  assert.equal(before.body.conversationId, null);
  assert.equal(
    f.app.store.db
      .prepare('SELECT count(*) n FROM pi_assistance_parents WHERE owner=?')
      .get(f.owner.user.id).n,
    0,
  );
  const session = await openedHelper(f, source);
  time += 30 * 60000;
  const status = await f.req('/pi/assist/preferences', { source }, f.owner.token);
  assert.equal(status.status, 200);
  assert.equal(status.body.expiresAt, session.expiresAt);
  assert.equal(status.body.conversationId, session.conversationId);
  assert.equal((await f.req('/pi/assist/preferences', { source }, f.other.token)).status, 404);
  assert.equal(
    (await f.req('/pi/assist/preferences', { source, ttlHours: 24 }, f.owner.token)).status,
    400,
  );
  time += 31 * 60000;
  const expired = await f.req('/pi/assist/preferences', { source }, f.owner.token);
  assert.equal(expired.status, 200);
  assert.equal(expired.body.conversationId, null);
  assert(expired.body.expiredConversationIds.includes(session.conversationId));
  assert.equal(f.runs.length, 0);
  assert.equal(f.deletions.length, 1);
});
