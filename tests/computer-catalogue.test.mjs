import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readComputerCatalogueCache,
  refreshComputerCatalogue,
} from '../shared/computer-catalogue.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const device = (id) => ({ id, name: id, online: true, lastSeen: '' });
const project = (id) => ({ id, name: id, readOnly: false, allowExecute: true });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

test('fast computer projects become usable while another computer is still waiting', async () => {
  const slow = deferred(),
    changes = [];
  const load = refreshComputerCatalogue({
    read: async (path) => {
      if (path === '/relay/devices') return { devices: [device('fast'), device('slow')] };
      if (path.endsWith('fast')) return { projects: [project('current')] };
      return slow.promise;
    },
    onChange: (groups) => changes.push(groups),
  });
  await tick();
  assert.equal(changes.at(-1)[0].verified, true);
  assert.equal(changes.at(-1)[0].projects[0].id, 'current');
  assert.equal(changes.at(-1)[1].loading, true);
  slow.resolve({ projects: [project('other')] });
  await load;
  assert.equal(changes.at(-1)[1].verified, true);
});

test('cached projects are display-only; a failed refresh retains them without retaining verification', async () => {
  const cache = new Map([
    ['/relay/devices', { devices: [device('one')] }],
    ['/relay/projects?deviceId=one', { projects: [project('known')] }],
  ]);
  const cached = readComputerCatalogueCache((path) => cache.get(path));
  assert.equal(cached[0].verified, false);
  const changes = [];
  await refreshComputerCatalogue({
    seed: [{ ...cached[0], verified: true }],
    read: async (path) => {
      if (path === '/relay/devices') return { devices: [device('one')] };
      throw Error('computer timeout');
    },
    onChange: (groups) => changes.push(groups),
  });
  assert.equal(changes[0][0].verified, true);
  assert.equal(changes.at(-1)[0].verified, false);
  assert.equal(changes.at(-1)[0].loading, false);
  assert.equal(changes.at(-1)[0].projects[0].id, 'known');
  assert.equal(changes.at(-1)[0].error, 'computer timeout');
});

test('device list failure preserves known history labels but invalidates previous verification', async () => {
  let groups;
  await assert.rejects(
    refreshComputerCatalogue({
      seed: [{ device: device('one'), projects: [project('known')], verified: true }],
      read: async () => {
        throw Error('server timeout');
      },
      onChange: (next) => {
        groups = next;
      },
    }),
    /server timeout/,
  );
  assert.equal(groups[0].projects[0].id, 'known');
  assert.equal(groups[0].verified, false);
  assert.equal(groups[0].loading, false);
});

test('aborted and obsolete account requests cannot publish late catalogue results', async () => {
  for (const abort of [true, false]) {
    const pending = deferred(),
      controller = new AbortController(),
      changes = [];
    let active = true;
    const load = refreshComputerCatalogue({
      signal: controller.signal,
      active: () => active,
      read: async (path) =>
        path === '/relay/devices' ? { devices: [device('old-owner')] } : pending.promise,
      onChange: (next) => changes.push(next),
    });
    await tick();
    const before = changes.length;
    if (abort) controller.abort();
    else active = false;
    pending.resolve({ projects: [project('old-private-project')] });
    await load;
    assert.equal(changes.length, before);
    assert.equal(changes.at(-1)[0].projects.length, 0);
  }
});

test('fresh grant removal replaces cached projects and other scopes never supply a seed', async () => {
  const scopeA = new Map([
    ['/relay/devices', { devices: [device('one')] }],
    ['/relay/projects?deviceId=one', { projects: [project('private-A')] }],
  ]);
  const scopeB = new Map();
  assert.equal(readComputerCatalogueCache((path) => scopeA.get(path))[0].projects.length, 1);
  assert.deepEqual(
    readComputerCatalogueCache((path) => scopeB.get(path)),
    [],
  );
  let groups;
  await refreshComputerCatalogue({
    seed: readComputerCatalogueCache((path) => scopeA.get(path)),
    read: async (path) =>
      path === '/relay/devices' ? { devices: [device('one')] } : { projects: [] },
    onChange: (next) => {
      groups = next;
    },
  });
  assert.deepEqual(groups[0].projects, []);
  assert.equal(groups[0].verified, true);
});
