import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ImapFlow } from 'imapflow';
import { createMail } from '../server/mail.mjs';

function fixture(t, capabilities = ['ESEARCH', 'PARTIAL']) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const state = {
    uids: Array.from({ length: 120 }, (_, i) => i + 1),
    validity: 1n,
    calls: [],
    returned: 0,
    fetched: 0,
  };
  const mail = createMail(
    { db },
    {
      token: 'synthetic-mail-pagination-test',
      imapFactory: async () => ({
        capabilities: new Set(capabilities),
        get mailbox() {
          return { uidValidity: state.validity };
        },
        async connect() {},
        async logout() {},
        async getMailboxLock() {
          return { release() {} };
        },
        async search(query, options) {
          state.calls.push({ query, options });
          const uids = state.uids.filter(
            (uid) =>
              (!query.uid || uid < Number(query.uid.split(':')[1]) + 1) &&
              (!query.text || uid % 2 === 0),
          );
          const partial = options.returnOptions?.find((value) => value.partial);
          const values = partial ? uids.slice(Number(partial.partial.split(':')[0])) : uids;
          state.returned += values.length;
          if (!partial) return values;
          return (
            state.bad ?? {
              count: uids.length,
              partial: { range: partial.partial, messages: values.join(',') },
            }
          );
        },
        async fetchAll(uids) {
          state.fetched += uids.length;
          return uids.map((uid) => ({ uid, envelope: {}, flags: new Set() }));
        },
      }),
    },
  );
  return {
    state,
    mail,
    async setup() {
      await mail.saveAccount('test', {
        provider: 'gmail',
        address: 'test@example.com',
        appPassword: 'synthetic-password',
      });
    },
    list(input = {}) {
      return mail.listMessages('test', { mailbox: 'Archive', limit: 10, ...input }, true);
    },
  };
}

test('PARTIAL reduces three-page UID results while preserving legacy pages and totals', async (t) => {
  const pages = [];
  for (const capabilities of [
    [],
    ['ESEARCH'],
    ['PARTIAL'],
    ['ESEARCH', 'PARTIAL'],
    ['IMAP4rev2', 'PARTIAL'],
    ['IMAP4rev1', 'IMAP4rev2', 'PARTIAL'],
  ]) {
    const f = fixture(t, capabilities);
    await f.setup();
    let cursor;
    const result = [];
    for (let i = 0; i < 3; i++) {
      const page = await f.list(cursor ? { cursor } : {});
      result.push(page.messages.map((m) => m.uid));
      assert.equal(page.total, 120);
      assert.equal(page.hasMore, true);
      cursor = page.nextCursor;
    }
    assert.equal(f.state.fetched, 30);
    const optimized = capabilities.includes('PARTIAL') && capabilities.length === 2;
    assert.equal(f.state.returned, optimized ? 33 : 330);
    assert.equal(f.state.calls.length, 3);
    if (optimized)
      assert.deepEqual(f.state.calls[0].options, {
        uid: true,
        returnOptions: ['COUNT', { partial: '-11:-1' }],
      });
    pages.push(result);
  }
  for (const result of pages) assert.deepEqual(result, pages[0]);
});

test('filtered sparse pages retain predicates and exclusive UID cursor across expunges and arrivals', async (t) => {
  for (const capabilities of [[], ['ESEARCH', 'PARTIAL']]) {
    const f = fixture(t, capabilities);
    await f.setup();
    f.state.uids = [1, 2, 20, 40, 60, 80, 100, 120, 140, 160, 180, 200, 220];
    const filter = { q: 'even', unread: true, since: '2026-01-01', before: '2026-12-01' };
    const first = await f.list(filter);
    assert.deepEqual(
      first.messages.map((m) => m.uid),
      [220, 200, 180, 160, 140, 120, 100, 80, 60, 40],
    );
    f.state.uids = [1, 2, 30, 40, 60, 80, 100, 120, 140, 160, 180, 200, 220, 240];
    const second = await f.list({ ...filter, cursor: first.nextCursor });
    assert.deepEqual(
      second.messages.map((m) => m.uid),
      [30, 2],
    );
    assert.equal(second.total, 12);
    assert.equal(second.hasMore, false);
    assert.equal(second.nextCursor, null);
    const query = f.state.calls.at(-1).query;
    assert.equal(query.uid, '1:39');
    assert.equal(query.text, 'even');
    assert.equal(query.seen, false);
    assert.equal(query.since.toISOString(), '2026-01-01T00:00:00.000Z');
    assert.equal(query.before.toISOString(), '2026-12-01T00:00:00.000Z');
    await assert.rejects(f.list({ cursor: first.nextCursor }), { status: 409 });
    f.state.validity = 2n;
    await assert.rejects(f.list({ ...filter, cursor: first.nextCursor }), { status: 409 });
  }
});

test('empty, exact-size, UID-one and exhausted cursor pages do not invent continuations', async (t) => {
  const f = fixture(t);
  await f.setup();
  for (const uids of [[], [1], Array.from({ length: 10 }, (_, i) => i + 1)]) {
    f.state.uids = uids;
    const page = await f.list();
    assert.equal(page.total, uids.length);
    assert.equal(page.hasMore, false);
    assert.equal(page.nextCursor, null);
  }
  f.state.uids = Array.from({ length: 11 }, (_, i) => i + 1);
  const first = await f.list();
  f.state.uids = [11];
  const empty = await f.list({ cursor: first.nextCursor });
  assert.deepEqual(empty.messages, []);
  assert.equal(empty.total, 11);
  assert.equal(empty.hasMore, false);
  await assert.rejects(f.list({ cursor: 'invalid' }), { status: 409 });
});

test('initial unfiltered INBOX keeps full UID observation even on PARTIAL servers', async (t) => {
  const f = fixture(t);
  await f.setup();
  const first = await f.list({ mailbox: 'INBOX' });
  assert.equal(f.state.returned, 120);
  assert.deepEqual(f.state.calls[0].options, { uid: true });
  await f.list({ mailbox: 'INBOX', cursor: first.nextCursor });
  assert.equal(f.state.returned, 131);
});

test('malformed or oversized PARTIAL replies fail explicitly rather than silently truncating', async (t) => {
  const f = fixture(t);
  await f.setup();
  for (const bad of [
    false,
    {},
    { count: 120 },
    { count: 120, partial: { messages: '1:4294967295' } },
    { count: 120, partial: { messages: '1,1' } },
    { count: 120, partial: { messages: '1:10' } },
    { count: 1, partial: { messages: '*' } },
    { count: 1, partial: { messages: '4294967296' } },
  ]) {
    f.state.bad = bad && { ...bad, partial: bad.partial && { range: '-11:-1', ...bad.partial } };
    await assert.rejects(f.list(), { status: 502 });
  }
  f.state.bad = { count: 3, partial: { range: '-11:-1', messages: '120:118' } };
  assert.deepEqual(
    (await f.list()).messages.map((m) => m.uid),
    [120, 119, 118],
  );
});

test('installed ImapFlow public search preserves ESEARCH COUNT and PARTIAL object without local expansion', async () => {
  const result = { count: 120, partial: { range: '-11:-1', messages: '110:120' } };
  const options = { uid: true, returnOptions: ['COUNT', { partial: '-11:-1' }] };
  const observed = [];
  const value = await ImapFlow.prototype.search.call(
    {
      mailbox: {},
      async run(...args) {
        observed.push(args);
        return result;
      },
    },
    { text: 'needle', uid: '1:200' },
    options,
  );
  assert.equal(value, result);
  assert.deepEqual(observed, [['SEARCH', { text: 'needle', uid: '1:200' }, options]]);
});

test('installed SEARCH command emits UID PARTIAL with filters and parses a protocol ESEARCH reply', async () => {
  const { default: search } = await import(
    new URL('./commands/search.js', import.meta.resolve('imapflow'))
  );
  const atom = (value) => ({ type: 'ATOM', value });
  const calls = [];
  const connection = {
    state: 1,
    states: { SELECTED: 1 },
    mailbox: {},
    capabilities: new Set(['ESEARCH', 'PARTIAL']),
    enabled: new Set(),
    async exec(command, attributes, handlers) {
      calls.push({ command, attributes });
      await handlers.untagged.ESEARCH({
        attributes: [
          [atom('TAG'), atom('A1')],
          atom('UID'),
          atom('COUNT'),
          atom('120'),
          atom('PARTIAL'),
          [atom('-11:-1'), atom('110:120')],
        ],
      });
      return { next() {} };
    },
  };
  const result = await search(
    connection,
    { uid: '1:200', text: 'needle', seen: false },
    {
      uid: true,
      returnOptions: ['COUNT', { partial: '-11:-1' }],
    },
  );
  assert.deepEqual(result, { count: 120, partial: { range: '-11:-1', messages: '110:120' } });
  assert.equal(calls[0].command, 'UID SEARCH');
  assert.deepEqual(calls[0].attributes.slice(0, 2), [
    atom('RETURN'),
    [atom('COUNT'), atom('PARTIAL'), atom('-11:-1')],
  ]);
  const wire = JSON.stringify(calls[0].attributes);
  for (const value of ['1:200', 'needle', 'UNSEEN']) assert.ok(wire.includes(value), value);
});

async function protocolFixture(t) {
  const base = import.meta.resolve('imapflow');
  const { default: search } = await import(new URL('./commands/search.js', base));
  const { parser } = await import(new URL('./handler/imap-handler.js', base));
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const state = {
    wire: '* ESEARCH (TAG "A1") UID COUNT 0 PARTIAL (-11:-1 NIL)',
    queries: [],
    fetched: 0,
  };
  const client = {
    state: 1,
    states: { SELECTED: 1 },
    mailbox: { uidValidity: 1n },
    capabilities: new Set(['ESEARCH', 'PARTIAL']),
    enabled: new Set(),
    async connect() {},
    async logout() {},
    async getMailboxLock() {
      return { release() {} };
    },
    async search(query, options) {
      state.queries.push(query);
      return ImapFlow.prototype.search.call(client, query, options);
    },
    async run(command, query, options) {
      assert.equal(command, 'SEARCH');
      return search(client, query, options);
    },
    async exec(command, attributes, handlers) {
      assert.equal(command, 'UID SEARCH');
      assert.deepEqual(attributes.slice(0, 2), [
        { type: 'ATOM', value: 'RETURN' },
        ['COUNT', 'PARTIAL', '-11:-1'].map((value) => ({ type: 'ATOM', value })),
      ]);
      await handlers.untagged.ESEARCH(await parser(Buffer.from(state.wire)));
      return { next() {} };
    },
    async fetchAll(uids) {
      state.fetched += uids.length;
      return uids.map((uid) => ({ uid, envelope: {}, flags: new Set() }));
    },
  };
  const mail = createMail(
    { db },
    { token: 'synthetic-mail-protocol-test', imapFactory: async () => client },
  );
  await mail.saveAccount('test', {
    provider: 'gmail',
    address: 'test@example.com',
    appPassword: 'synthetic-password',
  });
  return {
    state,
    list(input = {}) {
      return mail.listMessages('test', { mailbox: 'Archive', limit: 10, ...input }, true);
    },
  };
}

test('raw RFC 9394 NIL reply produces an empty Archive through ImapFlow and mail service', async (t) => {
  const f = await protocolFixture(t);
  const page = await f.list();
  assert.deepEqual(page.messages, []);
  assert.equal(page.total, 0);
  assert.equal(page.hasMore, false);
  assert.equal(page.nextCursor, null);
  assert.equal(f.state.fetched, 0);
});

test('raw RFC 9394 NIL reply preserves zero-match INBOX filters without fetching messages', async (t) => {
  const f = await protocolFixture(t);
  const page = await f.list({ mailbox: 'INBOX', q: 'zero-match', unread: true });
  assert.deepEqual(f.state.queries, [{ text: 'zero-match', seen: false }]);
  assert.deepEqual(page.messages, []);
  assert.equal(page.total, 0);
  assert.equal(page.hasMore, false);
  assert.equal(page.nextCursor, null);
  assert.equal(f.state.fetched, 0);
});

test('raw RFC 9394 NIL reply ends an expunged cursor page and preserves its original total', async (t) => {
  const f = await protocolFixture(t);
  f.state.wire = '* ESEARCH (TAG "A1") UID COUNT 11 PARTIAL (-11:-1 1:11)';
  const first = await f.list();
  assert.deepEqual(
    first.messages.map((message) => message.uid),
    [11, 10, 9, 8, 7, 6, 5, 4, 3, 2],
  );
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);
  f.state.wire = '* ESEARCH (TAG "A1") UID COUNT 0 PARTIAL (-11:-1 NIL)';
  const empty = await f.list({ cursor: first.nextCursor });
  assert.deepEqual(f.state.queries.at(-1), { uid: '1:1' });
  assert.deepEqual(empty.messages, []);
  assert.equal(empty.total, 11);
  assert.equal(empty.hasMore, false);
  assert.equal(empty.nextCursor, null);
  assert.equal(f.state.fetched, 10);
});
