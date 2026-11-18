import test from 'node:test';
import assert from 'node:assert/strict';
import { unifiedAdapters } from '../server/unified-adapters.mjs';

function gate() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture() {
  const pi = gate(),
    remote = new Map([
      ['first', gate()],
      ['second', gate()],
    ]);
  const order = [];
  let clock = 100000,
    projects = [{ id: 'pi-project', name: 'Pi' }];
  const db = {
    exec() {},
    prepare() {
      return { all: () => [], get: () => undefined, run() {} };
    },
  };
  const adapters = unifiedAdapters(db, {
    now: () => clock,
    community: {
      piReady: true,
      unified: {
        projects: async (actor) => {
          order.push(`${actor.id}:pi:start`);
          await pi.promise;
          order.push(`${actor.id}:pi:end`);
          return { projects };
        },
      },
    },
    relay: {},
    dshRemote: {
      status(owner) {
        return { chatAvailable: true, connections: [{ id: 'first' }, { id: 'second' }] };
      },
      async handle(_req, url, json, actor) {
        const id = url.pathname.split('/').at(-2);
        order.push(`${actor.id}:remote:${id}:start`);
        await remote.get(id).promise;
        order.push(`${actor.id}:remote:${id}:end`);
        json(200, {
          host: { location: 'server', deviceId: id, name: id },
          workspaces: [{ id: `${actor.id}-${id}`, name: id }],
        });
        return true;
      },
    },
  });
  return {
    adapters,
    pi,
    remote,
    order,
    advance: () => {
      clock += 15001;
    },
    revoke: () => {
      projects = [];
    },
  };
}
const owner = { id: 'owner' };
for (const first of ['pi', 'remote']) {
  test(`Pi and Remote start together and preserve directory order when ${first} finishes first`, async () => {
    const f = fixture();
    const read = f.adapters.targets(owner);
    assert.deepEqual(f.order, [
      'owner:pi:start',
      'owner:remote:first:start',
      'owner:remote:second:start',
    ]);
    if (first === 'pi') f.pi.resolve();
    else {
      f.remote.get('second').resolve();
      f.remote.get('first').resolve();
    }
    await new Promise(setImmediate);
    if (first === 'pi') {
      assert.ok(f.order.includes('owner:pi:end'));
      assert.ok(!f.order.includes('owner:remote:first:end'));
    } else {
      assert.ok(f.order.includes('owner:remote:first:end'));
      assert.ok(!f.order.includes('owner:pi:end'));
    }
    f.pi.resolve();
    for (const r of f.remote.values()) r.resolve();
    const targets = await read;
    assert.deepEqual(
      targets.map((t) => t.projectId),
      [null, 'pi-project', 'owner-first', 'owner-second'],
    );
  });
}
test('Pi rejection keeps successful Remote catalogues and failed Remote is isolated', async () => {
  const f = fixture();
  const read = f.adapters.targets(owner);
  f.remote.get('first').reject(Error('Remote unavailable'));
  await new Promise(setImmediate);
  f.pi.reject(Error('Pi unavailable'));
  f.remote.get('second').resolve();
  assert.deepEqual(
    (await read).map((t) => t.projectId),
    ['owner-second'],
  );
});
test('Remote failure does not discard Pi targets or another Remote response', async () => {
  const f = fixture();
  const read = f.adapters.targets(owner);
  f.pi.resolve();
  f.remote.get('first').resolve();
  f.remote.get('second').reject(Error('Remote unavailable'));
  assert.deepEqual(
    (await read).map((t) => t.projectId),
    [null, 'pi-project', 'owner-first'],
  );
});
test('same owner reads coalesce, cache expires and different owners remain isolated', async () => {
  const f = fixture();
  const one = f.adapters.targets(owner),
    two = f.adapters.targets(owner);
  const other = f.adapters.targets({ id: 'other' });
  assert.equal(f.order.filter((s) => s === 'owner:pi:start').length, 1);
  f.pi.resolve();
  for (const r of f.remote.values()) r.resolve();
  const [a, b, c] = await Promise.all([one, two, other]);
  assert.strictEqual(a, b);
  assert.ok(c.some((t) => t.projectId === 'other-first'));
  assert.ok(!c.some((t) => t.projectId === 'owner-first'));
  const count = f.order.length;
  assert.strictEqual(await f.adapters.targets(owner), a);
  assert.equal(f.order.length, count);
  f.advance();
  await f.adapters.targets(owner);
  assert.equal(f.order.filter((s) => s === 'owner:pi:start').length, 2);
});
test('Pi-only and deferred paths do not start Remote reads; warm directory cannot authorize revoked Pi project', async () => {
  const f = fixture();
  assert.deepEqual(
    f.adapters.deferredTargets(owner).map((t) => t.projectId),
    [null],
  );
  assert.deepEqual(f.order, []);
  const pi = f.adapters.piTargets(owner);
  f.pi.resolve();
  await pi;
  assert.ok(f.order.every((s) => !s.includes(':remote:')));
  const full = f.adapters.targets(owner);
  for (const r of f.remote.values()) r.resolve();
  await full;
  f.revoke();
  await assert.rejects(
    f.adapters.available(owner, { origin: 'server', projectId: 'pi-project' }),
    /当前不可用/,
  );
});
