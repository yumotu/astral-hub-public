import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createAssistanceContext, assistancePrompt } from '../server/assistance-context.mjs';
import { emptyDshSession } from '../shared/dsh-session.mjs';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE pi_conversations(owner TEXT,id TEXT,project_id TEXT);
    CREATE TABLE pi_turns(seq INTEGER PRIMARY KEY,owner TEXT,conversation_id TEXT,input TEXT,output TEXT,supplements TEXT,project_id TEXT);
    CREATE TABLE pi_tasks(seq INTEGER PRIMARY KEY,owner TEXT,conversation_id TEXT,payload TEXT,state TEXT);
    CREATE TABLE pi_closed_conversations(owner TEXT,conversation_id TEXT);
    CREATE TABLE pi_assistance_conversations(owner TEXT,id TEXT);
    CREATE TABLE relay_conversations(owner TEXT,id TEXT,device_id TEXT,project_id TEXT);
    CREATE TABLE relay_devices(owner TEXT,id TEXT,revoked INTEGER,expires INTEGER);
    CREATE TABLE relay_projects(device_id TEXT,id TEXT,revoked INTEGER);
    CREATE TABLE relay_jobs(owner TEXT,conversation_id TEXT,device_id TEXT,project_id TEXT,input TEXT,output TEXT,parent_id TEXT,status TEXT,created_at TEXT);
    CREATE TABLE dsh_conversations(owner TEXT,id TEXT,connection_id TEXT,snapshot TEXT);
    CREATE TABLE dsh_remote_connections(owner TEXT,id TEXT,revoked INTEGER);
    CREATE TABLE dsh_app_tasks(owner TEXT,id TEXT,conversation_id TEXT,input TEXT);`);
  return db;
}

test('temporary context includes only the owned main visible transcript and current partial answer', async (t) => {
  const db = fixture(t),
    id = randomUUID(),
    hidden = randomUUID();
  db.prepare('INSERT INTO pi_conversations VALUES(?,?,?)').run('owner', id, null);
  db.prepare('INSERT INTO pi_turns VALUES(?,?,?,?,?,?,?)').run(
    1,
    'owner',
    id,
    'Remember RRF',
    'Explained RRF',
    JSON.stringify([{ input: 'Also BM25' }]),
    null,
  );
  db.prepare('INSERT INTO pi_turns VALUES(?,?,?,?,?,?,?)').run(
    2,
    'other',
    hidden,
    'PRIVATE',
    'PRIVATE-ANSWER',
    '[]',
    null,
  );
  db.prepare('INSERT INTO pi_tasks VALUES(?,?,?,?,?)').run(
    1,
    'owner',
    id,
    JSON.stringify({ id: 'current', input: 'Current task' }),
    JSON.stringify({
      status: 'running',
      output: 'partial prose',
      thinking: 'hidden thinking',
      tools: [{ output: 'private tool details' }],
    }),
  );
  db.prepare('INSERT INTO pi_tasks VALUES(?,?,?,?,?)').run(
    2,
    'owner',
    id,
    JSON.stringify({ input: 'Applied live supplement', parentId: 'current' }),
    JSON.stringify({ status: 'applied' }),
  );
  db.prepare('INSERT INTO pi_tasks VALUES(?,?,?,?,?)').run(
    3,
    'owner',
    id,
    JSON.stringify({ input: 'UNDELIVERED-SUPPLEMENT', parentId: 'current' }),
    JSON.stringify({ status: 'error' }),
  );
  const service = createAssistanceContext(db),
    snapshot = await service.read('owner', { origin: 'server', id });
  assert.deepEqual(
    snapshot.messages.map((m) => m.content),
    [
      'Remember RRF',
      'Also BM25',
      'Explained RRF',
      'Current task',
      'Applied live supplement',
      'partial prose',
    ],
  );
  const prompt = assistancePrompt('What does this mean?', snapshot);
  assert.match(prompt, /Remember RRF/);
  assert.doesNotMatch(
    prompt,
    /PRIVATE|hidden thinking|private tool details|UNDELIVERED-SUPPLEMENT/,
  );
  await assert.rejects(service.read('other', { origin: 'server', id }), { status: 404 });
  await assert.rejects(service.read('owner', { origin: 'server', id: hidden }), { status: 404 });
});

test('source scope is checked again against project revocation, deletion and nested helpers', async (t) => {
  const db = fixture(t),
    id = randomUUID();
  db.prepare('INSERT INTO pi_conversations VALUES(?,?,?)').run('owner', id, 'alpha');
  let allowed = true,
    checked = 0;
  const service = createAssistanceContext(db, {
    serverProject: async (owner, project) => {
      checked++;
      assert.equal(owner, 'owner');
      assert.equal(project, 'alpha');
      if (!allowed) throw Object.assign(new Error('revoked'), { status: 403 });
    },
  });
  assert.equal((await service.read('owner', { origin: 'server', id })).messages.length, 0);
  allowed = false;
  await assert.rejects(service.read('owner', { origin: 'server', id }), { status: 403 });
  assert.equal(checked, 2);
  allowed = true;
  db.prepare('INSERT INTO pi_closed_conversations VALUES(?,?)').run('owner', id);
  await assert.rejects(service.read('owner', { origin: 'server', id }), { status: 404 });
  db.prepare('DELETE FROM pi_closed_conversations').run();
  db.prepare('INSERT INTO pi_assistance_conversations VALUES(?,?)').run('owner', id);
  await assert.rejects(service.read('owner', { origin: 'server', id }), { status: 409 });
});

test('computer source reads owned saved human messages without tools and rejects revoked projects/devices', async (t) => {
  const db = fixture(t),
    id = randomUUID();
  db.prepare('INSERT INTO relay_conversations VALUES(?,?,?,?)').run(
    'owner',
    id,
    'device',
    'project',
  );
  db.prepare('INSERT INTO relay_devices VALUES(?,?,?,?)').run('owner', 'device', 0, 10000);
  db.prepare('INSERT INTO relay_projects VALUES(?,?,?)').run('device', 'project', 0);
  const put = db.prepare('INSERT INTO relay_jobs VALUES(?,?,?,?,?,?,?,?,?)');
  put.run('owner', id, 'device', 'project', 'Main question', 'Main answer', null, 'done', '1');
  put.run(
    'owner',
    id,
    'device',
    'project',
    'Supplement',
    'receipt should not appear',
    'parent',
    'applied',
    '2',
  );
  put.run('other', id, 'device', 'project', 'OTHER-USER', 'OTHER-ANSWER', null, 'done', '3');
  put.run('owner', id, 'device', 'project', 'NOT-DELIVERED', '', 'parent', 'cancelled', '3');
  const service = createAssistanceContext(db, { now: () => 5000 }),
    source = { origin: 'computer', id };
  assert.deepEqual(
    (await service.read('owner', source)).messages.map((m) => m.content),
    ['Main question', 'Main answer', 'Supplement'],
  );
  await assert.rejects(service.read('other', source), { status: 404 });
  db.prepare('UPDATE relay_projects SET revoked=1').run();
  await assert.rejects(service.read('owner', source), { status: 403 });
  db.prepare('UPDATE relay_projects SET revoked=0').run();
  db.prepare('UPDATE relay_devices SET expires=4000').run();
  await assert.rejects(service.read('owner', source), { status: 403 });
});

test('DSH source uses visible transcript and strips software envelopes, thinking and tools', async (t) => {
  const db = fixture(t),
    id = randomUUID();
  const state = emptyDshSession();
  state.events = [
    {
      type: 'user/message',
      seq: 1,
      time: 1,
      data: {
        content: [{ type: 'text', text: 'RAW_INTERNAL_ENVELOPE' }],
        source: { kind: 'user', rpcId: 'request' },
      },
    },
    {
      type: 'assistant/message',
      seq: 2,
      time: 2,
      data: {
        content: [
          { type: 'reasoning', text: 'PRIVATE_THINKING' },
          { type: 'text', text: 'Visible answer' },
        ],
      },
    },
    {
      type: 'tool/result',
      seq: 3,
      time: 3,
      data: { content: [{ type: 'text', text: 'TOOL_PRIVATE' }] },
    },
  ];
  db.prepare('INSERT INTO dsh_conversations VALUES(?,?,?,?)').run(
    'owner',
    id,
    'connection',
    JSON.stringify(state),
  );
  db.prepare('INSERT INTO dsh_remote_connections VALUES(?,?,?)').run('owner', 'connection', 0);
  db.prepare('INSERT INTO dsh_app_tasks VALUES(?,?,?,?)').run(
    'owner',
    'request',
    id,
    'Human request',
  );
  const service = createAssistanceContext(db),
    source = { origin: 'remote', id };
  const snapshot = await service.read('owner', source);
  assert.deepEqual(
    snapshot.messages.map((m) => m.content),
    ['Human request', 'Visible answer'],
  );
  assert.doesNotMatch(
    assistancePrompt('Explain', snapshot),
    /RAW_INTERNAL_ENVELOPE|PRIVATE_THINKING|TOOL_PRIVATE/,
  );
  await assert.rejects(service.read('other', source), { status: 404 });
  db.prepare('UPDATE dsh_remote_connections SET revoked=1').run();
  await assert.rejects(service.read('owner', source), { status: 403 });
});

test('bounded excerpts preserve the question and latest context even with JSON escaping', () => {
  const input = 'Explain the latest data.';
  const snapshot = {
    messages: [
      { role: 'user', content: 'OLD\n'.repeat(10000) },
      { role: 'assistant', content: 'LATEST\\\n\"'.repeat(5000) },
    ],
    hasMore: true,
  };
  const prompt = assistancePrompt(input, snapshot);
  assert.ok(prompt.length <= 8000, prompt.length);
  assert.match(prompt, /较早或过长内容已省略/);
  assert.match(prompt, /LATEST/);
  assert.ok(prompt.endsWith(input));
  assert.doesNotMatch(prompt, /OLD/);
  assert.equal(assistancePrompt('Original', null), 'Original');
  assert.throws(() => assistancePrompt('x'.repeat(7990), snapshot), { status: 400 });
});

test('helper reads the full unified visible conversation across engine segments and rechecks every original scope', async (t) => {
  const db = fixture(t),
    first = randomUUID(),
    last = randomUUID(),
    display = randomUUID();
  db.exec(
    'CREATE TABLE assistant_segments(owner TEXT,display_id TEXT,ordinal INTEGER,origin TEXT,native_id TEXT)',
  );
  for (const [index, id] of [first, last].entries()) {
    db.prepare('INSERT INTO pi_conversations VALUES(?,?,?)').run(
      'owner',
      id,
      index ? 'new-project' : 'original-project',
    );
    db.prepare('INSERT INTO assistant_segments VALUES(?,?,?,?,?)').run(
      'owner',
      display,
      index,
      'server',
      id,
    );
    db.prepare('INSERT INTO pi_turns VALUES(?,?,?,?,?,?,?)').run(
      index + 1,
      'owner',
      id,
      index ? 'Latest question' : 'Original question',
      index ? 'Latest answer' : 'Original answer',
      '[]',
      index ? 'new-project' : 'original-project',
    );
  }
  let revoked = false;
  const service = createAssistanceContext(db, {
    serverProject: async (owner, project) => {
      if (revoked && project === 'original-project')
        throw Object.assign(Error('revoked'), { status: 403 });
    },
  });
  assert.deepEqual(
    (await service.read('owner', { origin: 'server', id: last })).messages.map((m) => m.content),
    ['Original question', 'Original answer', 'Latest question', 'Latest answer'],
  );
  assert.deepEqual(
    (await service.readNative('owner', { origin: 'server', id: last })).messages.map(
      (m) => m.content,
    ),
    ['Latest question', 'Latest answer'],
  );
  await assert.rejects(service.read('other', { origin: 'server', id: last }), { status: 404 });
  revoked = true;
  await assert.rejects(service.read('owner', { origin: 'server', id: last }), { status: 403 });
});
