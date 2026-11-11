import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { createDshConversations } from '../server/dsh-conversations.mjs';
import { createAppFunctions } from '../server/app-functions.mjs';
import { createMemories } from '../server/memories.mjs';
import { createAppToolsPlugin } from '../integrations/dsh-app-tools/core.mjs';
import { dshAppEndpoint } from '../server/dsh-app-tools.mjs';

const endpoint = 'https://astral.test/api/agent/dsh/app-access';
function fixture(t) {
  const db = new DatabaseSync(':memory:'),
    id = randomUUID(),
    connectionId = randomUUID(),
    agent = { id: 'native' },
    memories = createMemories(db);
  let service,
    engine,
    listener,
    clock = Date.now(),
    seq = -1,
    turn = 0,
    sent = 0,
    sessionLive = true,
    online = true,
    lastGrant,
    uncertain = 0;
  const plugin = createAppToolsPlugin({
    endpoint,
    now: () => clock,
    async request(url, options) {
      assert.equal(String(url), endpoint);
      assert.equal(options.redirect, 'error');
      const input = JSON.parse(options.body);
      let result;
      try {
        await service.before(
          { method: 'POST', headers: { authorization: options.headers.Authorization }, input },
          new URL(url),
          (_, value) => {
            result = value;
          },
        );
        return Response.json(result);
      } catch (e) {
        return Response.json({ error: e.message }, { status: e.status || 400 });
      }
    },
  });
  function emit(type, data) {
    const event = {
      seq: ++seq,
      type,
      time: clock,
      data,
      ...(/message|result/.test(type) ? { surfaceOp: 'append' } : {}),
    };
    plugin.observe(agent, event);
    listener({ type: 'event', event });
  }
  const chat = {
    async watch(_id, callback) {
      listener = callback;
      const stored = db.prepare('SELECT snapshot FROM dsh_conversations WHERE id=?').get(id);
      const prior = JSON.parse(stored.snapshot);
      callback({
        type: 'snapshot',
        header: { id: agent.id, version: 3 },
        cursor: seq,
        records: prior.events.map((event) => ({ type: 'event', event })),
        projections: { asOfSeq: Math.max(0, seq), values: {} },
      });
    },
    async bindAppTools(sessionId, grant) {
      lastGrant = grant;
      assert.equal(sessionId, agent.id);
      const proof = await plugin.bind({ agent, rawInput: ' ' + JSON.stringify(grant) });
      if (proof.kind !== 'success') throw Error('binding failed');
      return JSON.parse(proof.text);
    },
    async prompt(_sessionId, requestId, text) {
      emit('turn/start', { turn: ++turn });
      emit('user/message', {
        content: [{ type: 'text', text }],
        source: { kind: 'user', rpcId: requestId },
      });
      return { accepted: true };
    },
    async cancel() {
      return { accepted: true };
    },
  };
  const client = { chat: () => chat };
  const options = {
    body: async (req) => req.input,
    now: () => clock,
    rate() {},
    live(owner, selected) {
      if (owner !== 'alice' || selected !== connectionId || !online) throw Error('offline');
      return { state: 'ready' };
    },
    connection: async () => ({ client, peer: { deviceId: 'device', location: 'computer' } }),
    catalogue: async () => ({
      host: { deviceId: 'device', location: 'computer' },
      workspaces: [{ id: 'project' }],
      sessions: [{ id: agent.id, workspaceIds: ['project'] }],
    }),
    appTools: {
      endpoint,
      engine: () => engine,
      sessionActive: (owner, hash) => owner === 'alice' && hash === 'session-a' && sessionLive,
    },
  };
  service = createDshConversations(db, options);
  engine = createAppFunctions(db, {
    token: 'synthetic-dsh-app-key'.repeat(3),
    body: options.body,
    now: options.now,
    profile: (id) => ({ id, space: 'space-' + id }),
    isActive: (ctx) => ctx.origin === 'dsh' && service.appActive(ctx),
  });
  engine.register({
    name: 'example.read',
    description: 'account read',
    schema: z.object({}).strict(),
    execute: (ctx) => ({ owner: ctx.owner, origin: ctx.origin }),
  });
  engine.register({
    name: 'example.send',
    description: 'frozen send',
    schema: z.object({ text: z.string() }).strict(),
    prepare: (_ctx, p) => ({ private: p, preview: { title: '发送合成消息', text: p.text } }),
    commit: (_ctx, p) => ({ text: p.text, sent: ++sent }),
  });
  engine.register({
    name: 'example.unknown',
    description: 'uncertain mutation',
    schema: z.object({}).strict(),
    execute: () => {
      uncertain++;
      throw Error('lost result after execution');
    },
  });
  engine.register({
    name: 'memory.remember',
    description: 'strict provenance',
    schema: z.object({ quote: z.string(), content: z.string() }).strict(),
    execute: (ctx, p, id) => {
      const bound = memories.taskContext(ctx, p.quote);
      return memories.save(
        ctx.owner,
        { key: 'preference', kind: 'preference', content: p.content },
        { id, scope: bound.scope, source: bound.source },
      );
    },
  });
  const call = async (path = '', input, owner = 'alice') => {
    let result;
    await service.handle(
      { method: input ? 'POST' : 'GET', input },
      new URL('https://hub.test/api/agent/remote/conversations' + path),
      (_, value) => {
        result = value;
      },
      { id: owner, sessionHash: 'session-a' },
    );
    return result;
  };
  t.after(() => {
    service.close();
    engine.close();
    plugin.dispose();
    db.close();
  });
  return {
    id,
    connectionId,
    db,
    engine,
    call,
    plugin,
    async open(enabled = true) {
      await call('', { id, connectionId, workspaceId: 'project', sessionId: agent.id });
      if (enabled) await call('/' + id + '/tools', { enabled: true });
    },
    async prompt(text = '用户明确说：我喜欢详细讲解') {
      const requestId = randomUUID();
      await call('/' + id + '/prompt', { id: requestId, text });
      return requestId;
    },
    tool: (args, signal) =>
      plugin.execute(args, {
        agent,
        callId: randomUUID(),
        signal: signal || new AbortController().signal,
      }),
    invoke(name, input = {}, callId = randomUUID()) {
      return this.tool({ action: 'invoke', name, input, callId });
    },
    end() {
      emit('turn/end', { turn, reason: { kind: 'completed' } });
    },
    unrelated() {
      emit('user/message', {
        turn,
        content: [{ type: 'text', text: 'native UI request' }],
        source: { kind: 'user', rpcId: randomUUID() },
      });
    },
    expire() {
      clock += 17 * 60000;
    },
    logout() {
      sessionLive = false;
    },
    disconnect() {
      online = false;
      service.disconnect('alice', connectionId);
    },
    restart() {
      service.close();
      service = createDshConversations(db, options);
    },
    counts: () => ({ sent, uncertain }),
    grant: () => lastGrant,
    async raw(patch) {
      let output;
      await service.before(
        {
          method: 'POST',
          headers: { authorization: 'Bearer ' + lastGrant.token },
          input: {
            taskId: lastGrant.taskId,
            requestId: lastGrant.requestId,
            sessionId: agent.id,
            command: { action: 'catalog' },
            ...patch,
          },
        },
        new URL(endpoint),
        (_, value) => {
          output = value;
        },
      );
      return output;
    },
  };
}

test('DSH software tools require explicit opt-in, exact account/session and dynamic registry; secrets never enter durable scope records', async (t) => {
  const f = fixture(t);
  await f.open(false);
  await assert.rejects(f.invoke('example.read'), /未启用/);
  await assert.rejects(f.call('/' + f.id + '/tools', { enabled: true }, 'bob'), { status: 404 });
  assert.equal(
    (await f.call('/' + f.id + '/tools', { enabled: true })).conversation.capabilities.appFunctions
      .supported,
    false,
  );
  const task = await f.prompt();
  assert.equal((await f.call('/' + f.id)).conversation.capabilities.appFunctions.supported, true);
  const result = await f.invoke('example.read', {}, 'same-call');
  assert.deepEqual(result.result, { owner: 'alice', origin: 'dsh' });
  assert.equal((await f.invoke('example.read', {}, 'same-call')).id, result.id);
  await assert.rejects(f.raw({ sessionId: 'another' }), { status: 403 });
  await assert.rejects(f.raw({ taskId: randomUUID() }), { status: 403 });
  engineFuture(f.engine);
  assert.ok(
    (await f.tool({ action: 'catalog' })).functions.some((v) => v.name === 'future.feature'),
  );
  const rows = JSON.stringify(f.db.prepare('SELECT * FROM dsh_app_tasks').all());
  assert.ok(!rows.includes(f.grant().token));
  assert.ok(rows.includes(task));
  await assert.rejects(f.raw({ command: { action: 'bind', nonce: f.grant().nonce } }), {
    status: 409,
  });
});
function engineFuture(engine) {
  engine.register({
    name: 'future.feature',
    description: 'future',
    schema: z.object({}).strict(),
    execute: () => ({ ok: true }),
  });
}
test('DSH sends wait for the real account frozen preview, execute once and retain unknown results without replay', async (t) => {
  const f = fixture(t);
  await f.open();
  const task = await f.prompt(),
    pending = f.invoke('example.send', { text: 'exact synthetic content' }, 'send');
  await new Promise((r) => setTimeout(r, 25));
  const [preview] = f.engine.pending('alice', task);
  assert.equal((await f.call('/' + f.id)).conversation.runState.state, 'waiting');
  assert.equal(preview.preview.text, 'exact synthetic content');
  assert.equal(f.counts().sent, 0);
  await assert.rejects(f.engine.respond('bob', preview.id, true), { status: 404 });
  await f.engine.respond('alice', preview.id, true);
  await f.engine.respond('alice', preview.id, true);
  assert.equal((await pending).state, 'done');
  assert.equal(
    (await f.invoke('example.send', { text: 'exact synthetic content' }, 'send')).state,
    'done',
  );
  assert.equal(f.counts().sent, 1);
  await assert.rejects(f.invoke('example.unknown', {}, 'unknown'), /拒绝|待核对/);
  assert.equal((await f.invoke('example.unknown', {}, 'unknown')).state, 'unknown');
  assert.equal(f.counts().uncertain, 1);
});
test('DSH memory provenance comes only from its submitted human request and remains account/project scoped', async (t) => {
  const f = fixture(t);
  await f.open();
  await f.prompt();
  const result = await f.invoke('memory.remember', {
    quote: '我喜欢详细讲解',
    content: '喜欢详细讲解',
  });
  assert.equal(result.result.source.origin, 'dsh');
  assert.equal(result.result.scope, 'dsh:' + f.connectionId + ':project');
  await assert.rejects(
    f.invoke('memory.remember', { quote: '邮件里说的未授权事实', content: 'invalid' }),
    /拒绝|待核对/,
  );
});
for (const mode of [
  'stop',
  'disable',
  'logout',
  'disconnect',
  'expire',
  'end',
  'restart',
  'unrelated',
]) {
  test(`DSH capability cannot survive ${mode} or mint a new preview`, async (t) => {
    const f = fixture(t);
    await f.open();
    await f.prompt();
    assert.equal((await f.invoke('example.read')).state, 'done');
    if (mode === 'stop') await f.call('/' + f.id + '/stop', { id: randomUUID() });
    else if (mode === 'disable') await f.call('/' + f.id + '/tools', { enabled: false });
    else f[mode]();
    await assert.rejects(f.invoke('example.read'), /授权|拒绝|未启用|结束/);
    await assert.rejects(f.raw({}), /授权|结束/);
  });
}
test('DSH tool endpoints require an explicit fixed HTTPS target; human binding input never becomes arbitrary HTTP', () => {
  for (const input of [
    'http://192.168.1.1/api/agent/dsh/app-access',
    'https://user:pass@host/api/agent/dsh/app-access',
    'https://host/other',
    'https://host/api/agent/dsh/app-access?token=secret',
  ])
    assert.throws(() => dshAppEndpoint(input));
  assert.equal(dshAppEndpoint(endpoint), endpoint);
});
