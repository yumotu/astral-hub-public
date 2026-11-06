import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
const mode = process.env.QA_AUDIT_MODE;
if (process.env.ASTRAL_ROLLBACK_FIXTURE !== '1' || !['seed', 'legacy', 'roundtrip'].includes(mode))
  throw new Error('Run only in the explicitly enabled synthetic rollback fixture container.');
assert.equal(await readFile('/qa/.astral-synthetic-rollback-fixture', 'utf8'), 'astral-rollback-fixture-v1\n');
const { createApp } = await import('/app/server/index.mjs');
const app = await createApp({ token: 'synthetic-rollback-audit-token-080-only', dataDir: '/qa/data', notifications: { start: false }, aiConfig: { apiKey: '' }, piConfig: { url: '', token: '' } });
const db = app.store.db;
function snapshot() {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
  return Object.fromEntries(names.map(name => {
    assert.match(name, /^[a-z_]+$/);
    const rows = db.prepare('SELECT * FROM ' + name + ' ORDER BY rowid').all();
    return [name, { count: rows.length, sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex') }];
  }));
}
let state;
if (mode === 'seed') {
  assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 0, 'Seed requires a new, empty synthetic database');
  const at = new Date().toISOString();
  state = { people: [] };
  for (const [index, username] of ['qa_owner', 'qa_alice', 'qa_bob'].entries()) {
    const person = { id: randomUUID(), username, token: randomBytes(32).toString('base64url'), conversation: randomUUID(), goal: randomUUID(), record: randomUUID() };
    db.prepare('INSERT INTO users(id,username,display_name,password,role,space,created_at) VALUES(?,?,?,?,?,?,?)').run(person.id, username, username, 'synthetic-not-a-login-password', index ? 'member' : 'owner', index ? person.id : 'legacy', at);
    db.prepare('INSERT INTO sessions(hash,user_id,expires) VALUES(?,?,?)').run(createHash('sha256').update(person.token).digest('hex'), person.id, Date.now() + 3600000);
    db.prepare('INSERT INTO private_records(owner,id,data,deleted) VALUES(?,?,?,0)').run(index ? person.id : 'legacy', person.record, JSON.stringify({ id: person.record, question: username + ' synthetic question', cards: [] }));
    if (index) {
      db.prepare('INSERT INTO pi_turns(id,owner,conversation_id,input,output,created_at,project_id,access,tools,attachments,artifacts,execution) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), person.id, person.conversation, 'synthetic input ' + username, 'synthetic output ' + username, at, randomUUID(), 'read', '[]', '[]', '[]', JSON.stringify({ rounds: 1 }));
      db.prepare('INSERT INTO pi_conversations(owner,id,title,title_source,title_attempted,project_id,access,pinned_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(person.id, person.conversation, username + ' saved title', index === 1 ? 'manual' : 'ai', 1, null, 'read', at, at, at);
      db.prepare('INSERT INTO pi_preferences(owner,default_project_id) VALUES(?,NULL)').run(person.id);
      db.prepare('INSERT INTO goals(owner,id,data) VALUES(?,?,?)').run(person.id, person.goal, JSON.stringify({ id: person.goal, title: username + ' goal', description: 'synthetic fixture', status: 'active', revision: 2, createdAt: at, updatedAt: at, steps: [{ id: randomUUID(), title: 'retain data', status: 'done' }] }));
    }
    state.people.push(person);
  }
  state.snapshot = snapshot();
  await writeFile('/qa/audit-state.json', JSON.stringify(state), { mode: 0o600 });
} else {
  state = JSON.parse(await readFile('/qa/audit-state.json', 'utf8'));
  assert.deepEqual(snapshot(), state.snapshot, 'Opening the stored data changed a table');
}
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
try {
  const base = 'http://127.0.0.1:' + app.server.address().port + '/api';
  async function request(person, path, data) {
    const response = await fetch(base + path, { method: data ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + person.token, ...(data ? { 'Content-Type': 'application/json' } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
    return { status: response.status, body: await response.json() };
  }
  const version = (await (await fetch(base + '/health')).json()).version;
  let projectStatus;
  for (const person of state.people) {
    const me = await request(person, '/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.user.id, person.id);
    const records = await request(person, '/sync', { entries: [] });
    assert.equal(records.status, 200);
    assert.deepEqual(records.body.entries.map(r => r.id), [person.record]);
    if (person.username === 'qa_owner') continue;
    const history = await request(person, '/pi/conversations/' + person.conversation);
    assert.equal(history.status, 200);
    assert.equal(history.body.turns.length, 1);
    assert.match(history.body.turns[0].output, new RegExp(person.username));
    const other = state.people.find(p => p.username !== person.username && p.username !== 'qa_owner');
    const denied = await request(person, '/pi/conversations/' + other.conversation);
    assert.equal(denied.body.turns.length, 0);
    const goals = await request(person, '/goals');
    assert.equal(goals.status, 200);
    assert.deepEqual(goals.body.goals.map(g => g.id), [person.goal]);
    projectStatus = (await request(person, '/pi/projects')).status;
    assert.equal(projectStatus, version === '0.7.34' ? 403 : 503);
  }
  assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.deepEqual(snapshot(), state.snapshot, 'Read-only API checks changed stored content');
  console.log(JSON.stringify({ mode, version, tableCount: Object.keys(state.snapshot).length, users: state.people.length, records: 3, histories: 2, goals: 2, accountIsolation: true, tableContentsUnchanged: true, memberProjectsStatus: projectStatus, modelCalls: 0 }));
} finally {
  app.server.closeIdleConnections();
  await new Promise(resolve => app.server.close(resolve));
}
