import test from 'node:test';
import assert from 'node:assert/strict';
import { dshDisplaySnapshot, dshDirectorySnapshot } from '../shared/dsh-display-cache.mjs';

test('DSH history restores readable content without cached permissions, interactions or tool authorizations', () => {
  const raw = {
    id: 'chat',
    connectionId: 'host',
    projectId: 'project',
    title: '继续工作',
    messages: [{ id: '1', role: 'assistant', text: '保留正文', thinking: '保留思考', time: 1 }],
    permissions: { currentValue: 'danger-full-access' },
    connection: 'connected',
    status: 'running',
    interactions: [{ id: 'approval', answerable: true }],
    actions: [{ id: 'write' }],
    appTools: { enabled: true, available: true, tasks: [{ secret: 'old-authorization' }] },
    inputs: { upload: [{ id: 'file', name: '文件.pdf', bytes: 12, token: 'secret' }] },
    artifacts: [{ taskId: 'task', file: { id: 'result', name: '图片.png', bytes: 5 } }],
  };
  const cached = dshDisplaySnapshot(raw);
  assert.equal(cached.messages[0].text, '保留正文');
  assert.equal(cached.inputs.upload[0].name, '文件.pdf');
  assert.equal(cached.artifacts[0].file.source, 'dsh');
  assert.equal(cached.connection, 'reconnecting');
  assert.equal(cached.state, 'cached');
  assert.deepEqual(cached.appTools, { enabled: false, available: false, tasks: [] });
  assert.deepEqual(cached.interactions, []);
  assert.deepEqual(cached.actions, []);
  assert.equal(cached.permissions, undefined);
  assert(!JSON.stringify(cached).includes('secret'));
  assert.deepEqual(dshDisplaySnapshot(cached), cached);
  assert.equal(raw.appTools.enabled, true);
});

test('DSH directory cache contains only labels, not credentials, fingerprints or native session actions', () => {
  const cached = dshDirectorySnapshot({
    connections: [
      {
        id: 'host',
        name: '我的电脑',
        origin: 'https://private-host',
        account: 'private-account',
        password: 'private-password',
        host: {
          deviceId: 'device',
          name: '电脑',
          fingerprint: 'private-fingerprint',
          location: 'computer',
        },
      },
    ],
    catalogues: {
      host: {
        workspaces: [{ id: 'work', name: '项目', path: '/private-path' }],
        sessions: [{ id: 'native-session' }],
      },
    },
  });
  assert.equal(cached.connections[0].host.name, '电脑');
  assert.equal(cached.catalogues.host.workspaces[0].name, '项目');
  assert.deepEqual(cached.catalogues.host.sessions, []);
  assert(!JSON.stringify(cached).includes('private-'));
  assert.deepEqual(dshDirectorySnapshot(cached), cached);
});

test('DSH malformed and oversized display snapshots are discarded or bounded', () => {
  assert.equal(dshDisplaySnapshot(null), null);
  assert.equal(dshDisplaySnapshot({ id: 'broken' }), null);
  const snapshot = dshDisplaySnapshot({
    id: 'chat',
    messages: Array.from({ length: 700 }, (_, i) => ({
      id: String(i),
      role: 'assistant',
      text: i === 699 ? 'x'.repeat(100000) : 'text',
    })),
  });
  assert.equal(snapshot.messages.length, 500);
  assert.equal(snapshot.messages[0].id, '200');
  assert.equal(snapshot.messages.at(-1).text.length, 64000);
  assert.deepEqual(dshDirectorySnapshot(null), { connections: [], catalogues: {} });
});

test('large DSH histories retain recent readable messages within the durable cache budget', () => {
  const snapshot = dshDisplaySnapshot({
    id: 'chat',
    messages: Array.from({ length: 500 }, (_, i) => ({
      id: String(i),
      role: 'assistant',
      text: '正文'.repeat(32000),
      thinking: '思考'.repeat(32000),
    })),
    tools: Array.from({ length: 300 }, (_, i) => ({
      id: String(i),
      arguments: 'x'.repeat(64000),
      output: 'x'.repeat(64000),
    })),
    inputs: Object.fromEntries(
      Array.from({ length: 500 }, (_, i) => [
        String(i),
        Array.from({ length: 8 }, () => ({ id: 'x', name: 'x'.repeat(500), bytes: 1 })),
      ]),
    ),
  });
  assert(snapshot.messages.length > 0 && snapshot.messages.length < 500);
  assert.equal(snapshot.messages.at(-1).id, '499');
  assert(JSON.stringify(snapshot).length < 700 * 1024);
  assert.deepEqual(dshDisplaySnapshot(snapshot), snapshot);
});
