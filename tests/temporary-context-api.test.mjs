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
  const appOptions = {
    token: admin,
    dataDir: dir,
    piConcurrency: 1,
    now: controls.now,
    temporaryChatSweepMs: controls.sweepMs,
    piConfig: {
      url: 'http://synthetic-pi',
      token: 'synthetic-only',
      fetch: async (url, options) => {
        if (url.endsWith('/health')) {
          await controls.health?.();
          return Response.json({ ready: true, nativeSessions: controls.nativeSessions ?? false });
        }
        if (url.endsWith('/sessions/delete')) {
          const payload = JSON.parse(options.body);
          deletions.push(payload);
          const result = await controls.deleteSession?.(payload);
          return result || Response.json({ ok: true });
        }
        if (/\/sessions\/(inspect|compact|context|fork)$/.test(url) || url.endsWith('/cancel')) {
          const result = await controls.nativeOperation?.(url, JSON.parse(options.body));
          if (result) return result;
          if (url.endsWith('/inspect'))
            return Response.json({ type: 'done', commands: [], context: { messageCount: 0 } });
          if (url.endsWith('/compact'))
            return Response.json({
              type: 'done',
              compaction: { summary: 'Preserved helper context', tokensBefore: 100 },
            });
          if (url.endsWith('/context'))
            return Response.json({ model: 'synthetic', contextWindow: 64000 });
          if (url.endsWith('/fork')) return Response.json({ native: true });
          return Response.json({ ok: true });
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
  };
  let app = await createApp(appOptions);
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
    get app() {
      return app;
    },
    close,
    restart: async () => {
      await close();
      app = await createApp(appOptions);
      closed = false;
      await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    },
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
  const f = await fixture(t, { nativeSessions: true }),
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
  const f = await fixture(t, { nativeSessions: true }),
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
  assert.equal(failed.status, 200);
  assert.equal(failed.body.cleanupPending, true);
  assert.equal(failed.body.conversationId, session.conversationId);
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
    1,
    'expiry must reserve a durable closed marker before requesting native deletion',
  );
  await f.restart();
  {
    const reopened = await f.req('/pi/assist/session', { source }, f.owner.token);
    assert.equal(reopened.status, 200);
    assert.equal(reopened.body.cleanupPending, true);
    assert.equal(reopened.body.conversationId, session.conversationId);
  }
  assert.equal(
    (await f.req('/pi/assist/preferences', { source, ttlHours: 6 }, f.owner.token, 'PATCH')).status,
    409,
  );
  assert.equal(
    (await f.req('/pi/assist/preferences', { source }, f.owner.token)).body.cleanupPending,
    true,
  );
  assert.equal(
    f.deletions.length,
    1,
    'reopen, polling and preferences must not retry uncertain deletion',
  );
  assert.equal(
    (
      await f.req(
        '/pi/assist',
        {
          conversationId: session.conversationId,
          source,
          id: randomUUID(),
          kind: 'selection',
          input: 'Do not recreate an erased native context',
        },
        f.owner.token,
      )
    ).status,
    409,
  );
  failDelete = false;
  assert.equal(
    (await f.req('/pi/conversations/' + session.conversationId, undefined, f.owner.token, 'DELETE'))
      .status,
    200,
  );
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

test('interrupted native helper operations retain expiry protection across restart and later successful observations', async (t) => {
  for (const action of ['inspect', 'compact', 'context', 'fork', 'cancel'])
    await t.test(action, async (t) => {
      let time = Date.now(),
        interrupt = true,
        calls = 0;
      const f = await fixture(t, {
        now: () => time,
        nativeSessions: true,
        nativeOperation: async () => {
          calls++;
          if (interrupt) throw Error('Synthetic transport interrupted after dispatch');
        },
      });
      const source = { origin: 'server', id: f.parent() };
      const session = await openedHelper(f, source);
      const task = await sendHelper(f, session);
      const result = await f.req(
        '/pi/conversations/' + session.conversationId + '/' + action,
        action === 'fork' ? { id: randomUUID(), turnId: task.id, position: 'after' } : {},
        f.owner.token,
      );
      assert.equal(result.status, 502, JSON.stringify(result.body));
      const protection = async () => {
        time += 2 * hour;
        const status = await f.req('/pi/assist/preferences', { source }, f.owner.token);
        assert.equal(status.status, 200, JSON.stringify(status.body));
        assert.equal(status.body.conversationId, session.conversationId);
        assert.equal(status.body.expiresAt, null);
        assert.equal(f.deletions.length, 0);
      };
      await protection();
      await f.restart();
      await protection();
      assert.equal(calls, 1, 'restarting or checking expiry must not replay uncertain work');
      interrupt = false;
      assert.equal(
        (await f.req('/pi/conversations/' + session.conversationId + '/context', {}, f.owner.token))
          .status,
        200,
      );
      await protection();
      assert.equal(calls, 2, 'a later successful observation cannot settle an earlier operation');
      assert.equal(f.runs.length, 1);
    });
});

test('confirmed native helper rejections do not leave permanent expiry uncertainty', async (t) => {
  for (const status of [400, 403, 404, 409, 413, 429])
    await t.test(String(status), async (t) => {
      let time = Date.now();
      const f = await fixture(t, {
        now: () => time,
        nativeSessions: true,
        nativeOperation: async () => Response.json({ error: 'Synthetic rejection' }, { status }),
      });
      const source = { origin: 'server', id: f.parent() };
      const session = await openedHelper(f, source);
      assert.equal(
        (await f.req('/pi/conversations/' + session.conversationId + '/compact', {}, f.owner.token))
          .status,
        status,
      );
      await f.restart();
      time += 2 * hour;
      const expired = await f.req('/pi/assist/preferences', { source }, f.owner.token);
      assert.equal(expired.status, 200, JSON.stringify(expired.body));
      assert.equal(expired.body.conversationId, null);
      assert.equal(f.deletions.length, 1);
    });
});

test('HTTP 200 without the native endpoint acknowledgement leaves helper work unknown', async (t) => {
  for (const action of ['inspect', 'compact', 'context', 'fork', 'cancel'])
    for (const outcome of ['error', 'empty', 'null', 'array', 'wrong-shape', 'error-with-ack'])
      await t.test(action + ':' + outcome, async (t) => {
        let time = Date.now();
        const good = {
          inspect: { type: 'done', commands: [], context: { messageCount: 0 } },
          compact: { type: 'done', compaction: { summary: 'Preserved context', tokensBefore: 10 } },
          context: { model: 'synthetic', contextWindow: 64000 },
          fork: { native: true },
          cancel: { ok: true },
        }[action];
        const malformed = {
          error: { error: 'Native outcome unconfirmed' },
          empty: {},
          null: null,
          array: [],
          'wrong-shape': {
            inspect: { context: [] },
            compact: { compaction: {} },
            context: { model: 'synthetic', contextWindow: '64000' },
            fork: { native: 'true' },
            cancel: { ok: 'true' },
          }[action],
          'error-with-ack': { ...good, error: 'Native outcome unconfirmed' },
        }[outcome];
        const f = await fixture(t, {
          now: () => time,
          nativeSessions: true,
          nativeOperation: async () => Response.json(malformed),
        });
        const source = { origin: 'server', id: f.parent() };
        const session = await openedHelper(f, source);
        const task = await sendHelper(f, session);
        const target = randomUUID();
        const result = await f.req(
          '/pi/conversations/' + session.conversationId + '/' + action,
          action === 'fork' ? { id: target, turnId: task.id, position: 'after' } : {},
          f.owner.token,
        );
        assert.equal(result.status, 502, JSON.stringify(result.body));
        assert.equal(
          f.app.store.db
            .prepare('SELECT state FROM pi_assistance_operations WHERE owner=? AND id=?')
            .get(f.owner.user.id, session.conversationId)?.state,
          'unknown',
        );
        if (action === 'fork')
          assert.equal(
            f.app.store.db
              .prepare('SELECT 1 FROM pi_conversations WHERE owner=? AND id=?')
              .get(f.owner.user.id, target),
            undefined,
            'an unacknowledged native fork must not publish a local branch',
          );
        await f.restart();
        time += 2 * hour;
        const status = await f.req('/pi/assist/preferences', { source }, f.owner.token);
        assert.equal(status.body.conversationId, session.conversationId);
        assert.equal(status.body.expiresAt, null);
        assert.equal(f.deletions.length, 0);
        assert.equal(f.runs.length, 1);
      });
});

test('manual and unified deletion protect pending or unknown native helper work across restart', async (t) => {
  for (const state of ['pending', 'unknown'])
    for (const indexed of [false, true])
      await t.test(state + ':' + (indexed ? 'unified' : 'native'), async (t) => {
        const f = await fixture(t, { nativeSessions: true });
        const source = { origin: 'server', id: f.parent() };
        const session = await openedHelper(f, source);
        await sendHelper(f, session);
        let display;
        if (indexed) {
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
          const list = await f.req('/assistant/conversations', undefined, f.owner.token);
          display = list.body.conversations.find(
            (c) => c.active.nativeId === session.conversationId,
          );
          assert(display);
        }
        const operationId = randomUUID();
        f.app.store.db
          .prepare('INSERT INTO pi_assistance_operations VALUES(?,?,?,?,?,?)')
          .run(f.owner.user.id, session.conversationId, operationId, 'context', state, Date.now());
        await f.restart();
        if (indexed) {
          const list = await f.req('/assistant/conversations', undefined, f.owner.token);
          assert.equal(
            list.body.conversations.find((c) => c.id === display.id).runState.busy,
            true,
          );
          assert.equal(
            (
              await f.req(
                '/assistant/conversations/' + display.id,
                undefined,
                f.owner.token,
                'DELETE',
              )
            ).status,
            409,
          );
          assert.equal(
            (
              await f.req(
                '/assistant/conversations/' + display.id + '/switch',
                {
                  id: randomUUID(),
                  target: { origin: 'remote', connectionId: randomUUID(), projectId: 'workspace' },
                },
                f.owner.token,
              )
            ).status,
            409,
            'unified state must reject an engine switch before target access or creation',
          );
        }
        assert.equal(
          (
            await f.req(
              '/pi/conversations/' + session.conversationId,
              undefined,
              f.owner.token,
              'DELETE',
            )
          ).status,
          409,
        );
        assert.equal(f.deletions.length, 0);
        assert.equal(
          f.app.store.db
            .prepare('SELECT state FROM pi_assistance_operations WHERE operation_id=?')
            .get(operationId).state,
          state,
        );
        assert.equal(
          f.app.store.db
            .prepare('SELECT count(*) n FROM pi_turns WHERE owner=? AND conversation_id=?')
            .get(f.owner.user.id, session.conversationId).n,
          1,
        );
      });
});

test('manual and unified deletion require a positive native deletion acknowledgement before removing local history', async (t) => {
  for (const indexed of [false, true])
    for (const [outcome, receipt] of [
      ['empty', {}],
      ['ok-false', { ok: false }],
      ['error', { error: 'Native deletion was not confirmed' }],
      ['ok-true', { ok: true }],
    ])
      await t.test((indexed ? 'unified' : 'manual') + ':' + outcome, async (t) => {
        let nativeReceipt = receipt;
        const f = await fixture(t, {
          nativeSessions: true,
          deleteSession: async () => Response.json(nativeReceipt),
        });
        const source = { origin: 'server', id: f.parent() };
        const session = await openedHelper(f, source);
        const task = await sendHelper(f, session);
        let display;
        if (indexed) {
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
          const list = await f.req('/assistant/conversations', undefined, f.owner.token);
          display = list.body.conversations.find(
            (c) => c.active.nativeId === session.conversationId,
          );
          assert(display);
        }
        const history = () =>
          ['pi_turns', 'pi_tasks'].map((table) =>
            f.app.store.db
              .prepare(`SELECT * FROM ${table} WHERE owner=? AND conversation_id=? ORDER BY id`)
              .all(f.owner.user.id, session.conversationId),
          );
        const before = history();
        assert.deepEqual(
          before.map((rows) => rows.length),
          [1, 1],
        );
        const path = indexed
          ? '/assistant/conversations/' + display.id
          : '/pi/conversations/' + session.conversationId;
        const response = await f.req(path, undefined, f.owner.token, 'DELETE');
        assert.equal(
          response.status,
          receipt.ok === true ? 200 : 502,
          JSON.stringify(response.body),
        );
        assert.equal(f.deletions.length, 1);
        assert.equal(f.runs.length, 1, 'deletion must not replay the helper task');
        if (receipt.ok === true) {
          assert.deepEqual(history(), [[], []]);
          assert.equal(response.body.ok, true);
          if (indexed)
            assert.equal(
              (await f.req('/assistant/conversations/' + display.id, undefined, f.owner.token))
                .status,
              404,
            );
        } else {
          assert.deepEqual(history(), before, 'unconfirmed deletion must preserve local history');
          const originalBinding = () =>
            f.app.store.db
              .prepare('SELECT DISTINCT id FROM pi_assistance_parents WHERE owner=?')
              .all(f.owner.user.id)
              .map((row) => row.id);
          assert.deepEqual(originalBinding(), [session.conversationId]);
          const reopening = await f.req('/pi/assist/session', { source }, f.owner.token);
          assert.equal(
            reopening.status,
            200,
            'unconfirmed deletion must expose preserved read-only history',
          );
          assert.equal(reopening.body.cleanupPending, true);
          assert.equal(reopening.body.conversationId, session.conversationId);
          assert.deepEqual(originalBinding(), [session.conversationId]);
          assert.deepEqual(history(), before);
          await f.restart();
          {
            const reopened = await f.req('/pi/assist/session', { source }, f.owner.token);
            assert.equal(reopened.status, 200);
            assert.equal(reopened.body.cleanupPending, true);
            assert.equal(reopened.body.conversationId, session.conversationId);
          }
          assert.deepEqual(originalBinding(), [session.conversationId]);
          assert.deepEqual(
            history(),
            before,
            'unconfirmed history must survive application restart',
          );
          if (indexed) {
            const list = await f.req('/assistant/conversations', undefined, f.owner.token);
            assert(list.body.conversations.some((c) => c.id === display.id));
          }
          assert.equal(f.deletions.length, 1, 'restart must not retry deletion automatically');
          assert.equal(f.runs.length, 1, 'restart must not replay the helper task');
          assert.equal(
            (
              await f.req(
                '/pi/assist',
                { ...task, id: randomUUID(), input: 'Do not send into a possibly deleted session' },
                f.owner.token,
              )
            ).status,
            409,
            'the durable closed marker must prevent new work after an unconfirmed deletion',
          );
          nativeReceipt = { ok: true };
          assert.equal((await f.req(path, undefined, f.owner.token, 'DELETE')).status, 200);
          assert.deepEqual(history(), [[], []]);
          assert.equal(
            f.deletions.length,
            2,
            'only an explicit retry may repeat idempotent deletion',
          );
          assert.equal(f.runs.length, 1, 'the deletion retry must not replay model work');
          const replacement = await openedHelper(f, source);
          assert.notEqual(replacement.conversationId, session.conversationId);
          assert.deepEqual(replacement.turns, []);
        }
      });
});

test('expiry deletion reserves protection before dispatch and keeps the same helper after response loss and restart', async (t) => {
  let time = Date.now(),
    receipt = {};
  const f = await fixture(t, {
    now: () => time,
    nativeSessions: true,
    deleteSession: () => {
      assert(
        f.app.store.db
          .prepare('SELECT 1 FROM pi_closed_conversations WHERE owner=? AND conversation_id=?')
          .get(f.owner.user.id, session.conversationId),
        'the durable dispatch barrier must precede native deletion',
      );
      return Response.json(receipt);
    },
  });
  const source = { origin: 'server', id: f.parent() },
    session = await openedHelper(f, source);
  await sendHelper(f, session);
  time += hour + 1;
  {
    const pending = await f.req('/pi/assist/session', { source }, f.owner.token);
    assert.equal(pending.status, 200);
    assert.equal(pending.body.cleanupPending, true);
    assert.equal(pending.body.conversationId, session.conversationId);
  }
  await f.restart();
  {
    const reopened = await f.req('/pi/assist/session', { source }, f.owner.token);
    assert.equal(reopened.status, 200);
    assert.equal(reopened.body.cleanupPending, true);
    assert.equal(reopened.body.conversationId, session.conversationId);
  }
  assert.equal(
    (await f.req('/pi/assist/preferences', { source, ttlHours: 24 }, f.owner.token, 'PATCH'))
      .status,
    409,
  );
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
  const preserved = await f.req(
    '/pi/conversations/' + session.conversationId,
    undefined,
    f.owner.token,
  );
  assert.equal(preserved.status, 200);
  assert.equal(preserved.body.turns.length, 1);
  assert.equal(f.deletions.length, 1);
  assert.equal(f.runs.length, 1);
  receipt = { ok: true };
  assert.equal(
    (await f.req('/pi/conversations/' + session.conversationId, undefined, f.owner.token, 'DELETE'))
      .status,
    200,
  );
  const next = await openedHelper(f, source);
  assert.notEqual(next.conversationId, session.conversationId);
  assert(next.expiredConversationIds.includes(session.conversationId));
  assert.equal(f.deletions.length, 2);
  assert.equal(f.runs.length, 1);
});

test('unconfirmed deletion keeps an unused native reservation across unified parent migration', async (t) => {
  let receipt = {};
  const f = await fixture(t, {
    nativeSessions: true,
    deleteSession: () => Response.json(receipt),
  });
  const first = f.parent(),
    next = f.parent(),
    display = randomUUID();
  const source = { origin: 'server', id: first };
  const session = await openedHelper(f, source);
  assert.equal(
    (await f.req('/pi/conversations/' + session.conversationId, undefined, f.owner.token, 'DELETE'))
      .status,
    502,
  );
  for (const [ordinal, nativeId] of [first, next].entries())
    f.app.store.db
      .prepare(
        'INSERT INTO assistant_segments(owner,display_id,ordinal,origin,native_id,runtime) VALUES(?,?,?,?,?,?)',
      )
      .run(f.owner.user.id, display, ordinal, 'server', nativeId, '{}');
  await f.restart();
  for (const id of [first, next]) {
    const pending = await f.req(
      '/pi/assist/session',
      { source: { origin: 'server', id } },
      f.owner.token,
    );
    assert.equal(pending.status, 200);
    assert.equal(pending.body.cleanupPending, true);
    assert.equal(pending.body.conversationId, session.conversationId);
  }
  assert.deepEqual(
    f.app.store.db
      .prepare('SELECT DISTINCT id FROM pi_assistance_parents WHERE owner=?')
      .all(f.owner.user.id)
      .map((row) => row.id),
    [session.conversationId],
  );
  assert.equal(f.deletions.length, 1);
  assert.equal(f.runs.length, 0);
  receipt = { ok: true };
  assert.equal(
    (await f.req('/pi/conversations/' + session.conversationId, undefined, f.owner.token, 'DELETE'))
      .status,
    200,
  );
  const reopened = await openedHelper(f, { origin: 'server', id: next });
  assert.notEqual(reopened.conversationId, session.conversationId);
  assert.deepEqual(reopened.turns, []);
  assert.equal(f.deletions.length, 2);
  assert.equal(f.runs.length, 0);
});

test('manual helper deletion rechecks native work started during its health request', async (t) => {
  let holdHealth = false,
    healthArrived,
    releaseHealth,
    nativeArrived,
    releaseNative;
  const healthEntered = new Promise((resolve) => {
    healthArrived = resolve;
  });
  const healthGate = new Promise((resolve) => {
    releaseHealth = resolve;
  });
  const nativeEntered = new Promise((resolve) => {
    nativeArrived = resolve;
  });
  const nativeGate = new Promise((resolve) => {
    releaseNative = resolve;
  });
  t.after(() => {
    releaseHealth();
    releaseNative();
  });
  const f = await fixture(t, {
    nativeSessions: true,
    health: async () => {
      if (holdHealth) {
        healthArrived();
        await healthGate;
      }
    },
    nativeOperation: async () => {
      nativeArrived();
      await nativeGate;
    },
  });
  const source = { origin: 'server', id: f.parent() };
  const session = await openedHelper(f, source);
  await sendHelper(f, session);
  holdHealth = true;
  const deletion = f.req(
    '/pi/conversations/' + session.conversationId,
    undefined,
    f.owner.token,
    'DELETE',
  );
  await Promise.race([
    healthEntered,
    new Promise((_, reject) =>
      setTimeout(() => reject(Error('Delete health check did not start')), 2000),
    ),
  ]);
  const operation = f.req(
    '/pi/conversations/' + session.conversationId + '/context',
    {},
    f.owner.token,
  );
  await Promise.race([
    nativeEntered,
    new Promise((_, reject) =>
      setTimeout(() => reject(Error('Native context request did not start')), 2000),
    ),
  ]);
  releaseHealth();
  assert.equal((await deletion).status, 409);
  assert.equal(f.deletions.length, 0);
  releaseNative();
  assert.equal((await operation).status, 200);
  assert.equal(f.runs.length, 1);
});

test('pending helper operation is recorded before dispatch and remains protected after application replacement', async (t) => {
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
      assert.deepEqual(
        { ...f.app.store.db.prepare('SELECT operation,state FROM pi_assistance_operations').get() },
        { operation: 'compact', state: 'pending' },
        'the reservation must be committed before native dispatch',
      );
      arrived();
      await gate;
    },
  });
  const source = { origin: 'server', id: f.parent() };
  const session = await openedHelper(f, source);
  // The HTTP response is deliberately discarded by application shutdown.
  const pending = f
    .req('/pi/conversations/' + session.conversationId + '/compact', {}, f.owner.token)
    .catch(() => null);
  await Promise.race([
    entered,
    new Promise((_, reject) =>
      setTimeout(() => reject(Error('Native dispatch did not start')), 2000),
    ),
  ]);
  await f.restart();
  time += 2 * hour;
  const status = await f.req('/pi/assist/preferences', { source }, f.owner.token);
  assert.equal(status.body.conversationId, session.conversationId);
  assert.equal(status.body.expiresAt, null);
  assert.equal(f.deletions.length, 0);
  release();
  await pending;
  // An acknowledgement arriving in the closed application must not touch the
  // replacement application's store or remove its conservative reservation.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const after = await f.req('/pi/assist/preferences', { source }, f.owner.token);
  assert.equal(after.body.conversationId, session.conversationId);
  assert.equal(after.body.expiresAt, null);
  assert.equal(f.deletions.length, 0);
  assert.equal(f.runs.length, 0);
});

test('invalid native responses and server failures keep helper outcomes unknown', async (t) => {
  for (const outcome of ['invalid-json', 500, 503])
    await t.test(String(outcome), async (t) => {
      let time = Date.now();
      const f = await fixture(t, {
        now: () => time,
        nativeSessions: true,
        nativeOperation: async () =>
          outcome === 'invalid-json'
            ? new Response('truncated json')
            : Response.json({ error: 'Native outcome unconfirmed' }, { status: outcome }),
      });
      const source = { origin: 'server', id: f.parent() };
      const session = await openedHelper(f, source);
      const result = await f.req(
        '/pi/conversations/' + session.conversationId + '/context',
        {},
        f.owner.token,
      );
      assert.equal(result.status, outcome === 503 ? 503 : 502);
      await f.restart();
      time += 2 * hour;
      const status = await f.req('/pi/assist/preferences', { source }, f.owner.token);
      assert.equal(status.body.conversationId, session.conversationId);
      assert.equal(status.body.expiresAt, null);
      assert.equal(f.deletions.length, 0);
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

test('manual deletion without native deletion capability preserves helper history and its binding', async (t) => {
  const f = await fixture(t, { nativeSessions: false });
  const source = { origin: 'server', id: f.parent() };
  const session = await openedHelper(f, source);
  await sendHelper(f, session);
  const result = await f.req(
    '/pi/conversations/' + session.conversationId,
    undefined,
    f.owner.token,
    'DELETE',
  );
  assert.equal(result.status, 503);
  assert.equal(f.deletions.length, 0);
  const reopened = await openedHelper(f, source);
  assert.equal(reopened.conversationId, session.conversationId);
  assert.equal(reopened.turns.length, 1);
  assert.equal(f.runs.length, 1);
});

test('source-based explicit cleanup exposes preserved pending history and only retries acknowledged deletion', async (t) => {
  let time = Date.now(),
    receipt = {};
  const f = await fixture(t, {
    now: () => time,
    nativeSessions: true,
    deleteSession: () => Response.json(receipt),
  });
  const source = { origin: 'server', id: f.parent() };
  const session = await openedHelper(f, source);
  const sent = await sendHelper(f, session);
  assert.equal(
    (await f.req('/pi/assist/cleanup', { source }, f.owner.token)).status,
    409,
    'live helpers cannot be silently cleared by the recovery endpoint',
  );
  time += hour + 1;
  const pending = await f.req('/pi/assist/session', { source }, f.owner.token);
  assert.equal(pending.status, 200);
  assert.equal(pending.body.cleanupPending, true);
  assert.equal(pending.body.conversationId, session.conversationId);
  assert.equal(pending.body.turns.length, 1);
  assert.equal(pending.body.tasks[0].id, sent.id);
  const originalDeadline = pending.body.expiresAt;
  await f.restart();
  const reopened = await f.req('/pi/assist/session', { source }, f.owner.token);
  assert.equal(reopened.status, 200);
  assert.equal(reopened.body.cleanupPending, true);
  assert.equal(reopened.body.conversationId, session.conversationId);
  assert.equal(
    reopened.body.expiresAt,
    originalDeadline,
    'opening pending history must not renew it',
  );
  const status = await f.req('/pi/assist/preferences', { source }, f.owner.token);
  assert.equal(status.status, 200);
  assert.equal(status.body.cleanupPending, true);
  assert.equal(status.body.conversationId, session.conversationId);
  assert.equal(f.deletions.length, 1, 'read-only recovery must not retry deletion');
  assert.equal(
    (await f.req('/pi/assist/preferences', { source, ttlHours: 6 }, f.owner.token, 'PATCH')).status,
    409,
  );
  assert.equal(
    (
      await f.req(
        '/pi/assist',
        { ...sent, id: randomUUID(), input: 'Do not recreate native context' },
        f.owner.token,
      )
    ).status,
    409,
  );
  assert.equal((await f.req('/pi/assist/cleanup', { source }, f.other.token)).status, 404);
  const retryFailed = await f.req('/pi/assist/cleanup', { source }, f.owner.token);
  assert.equal(retryFailed.status, 502);
  assert.equal((await f.req('/pi/assist/session', { source }, f.owner.token)).body.turns.length, 1);
  assert.equal(f.deletions.length, 2);
  receipt = { ok: true };
  const cleared = await f.req('/pi/assist/cleanup', { source }, f.owner.token);
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.cleanupPending, false);
  assert.equal(cleared.body.conversationId, null);
  assert(cleared.body.expiredConversationIds.includes(session.conversationId));
  assert.equal(f.deletions.length, 3);
  assert.equal(f.runs.length, 1, 'cleanup never replays a prompt');
  const repeated = await f.req('/pi/assist/cleanup', { source }, f.owner.token);
  assert.equal(repeated.status, 200);
  assert(repeated.body.expiredConversationIds.includes(session.conversationId));
  assert.equal(f.deletions.length, 3, 'confirmed cleanup is idempotent');
  const fresh = await openedHelper(f, source);
  assert.notEqual(fresh.conversationId, session.conversationId);
  assert.deepEqual(fresh.turns, []);
});
