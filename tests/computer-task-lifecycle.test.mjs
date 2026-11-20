import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createComputerTasks } from '../agent/task-runner.mjs';
import { localGrant } from '../agent/config.mjs';

test('computer task waits for drained IPC before deciding a worker exited without a result', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'astral-worker-close-'));
  let runner;
  try {
    await mkdir(join(dir, 'project'));
    const grant = await localGrant(join(dir, 'project'));
    const job = {
      id: randomUUID(),
      projectId: grant.id,
      access: 'read',
      execute: false,
      input: 'Synthetic task',
    };
    let offered = false;
    const uploads = [];
    const child = new EventEmitter();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.send = (_message, callback) => callback?.();
    runner = await createComputerTasks({
      config: () => ({ projects: [grant] }),
      configPath: join(dir, 'device.json'),
      backupDir: join(dir, 'backups'),
      piEntry: 'unused-fixture',
      ledgerFile: join(dir, 'ledger.sqlite'),
      spawnWorker: () => child,
      request: async (_config, path, value) => {
        if (path.includes('/jobs/poll')) {
          const next = offered ? null : job;
          offered = true;
          return { job: next };
        }
        uploads.push({ path, value });
        return {};
      },
    });
    await runner.poll();
    child.emit('message', {
      type: 'progress',
      state: { revision: 1, output: 'Partial', tools: [] },
    });
    child.exitCode = 0;
    child.emit('exit', 0, null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      uploads.filter((x) => x.path.endsWith('/result')).length,
      0,
      'exit synthesized a premature error',
    );
    const final = {
      revision: 2,
      output: 'Finished exactly once',
      tools: [],
      status: 'done',
      phase: '已完成',
      error: null,
    };
    child.emit('message', { type: 'result', state: final });
    child.emit('close', 0, null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      uploads.filter((x) => x.path.endsWith('/result')).map((x) => x.value),
      [final],
    );
    await runner.close();
    runner = null;
  } finally {
    await runner?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('computer task records an unknown exit once after close and does not replay it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'astral-worker-unknown-'));
  let runner;
  try {
    await mkdir(join(dir, 'project'));
    const grant = await localGrant(join(dir, 'project'));
    const job = {
      id: randomUUID(),
      projectId: grant.id,
      access: 'read',
      execute: false,
      input: 'Synthetic task',
    };
    const uploads = [];
    let spawned = 0;
    const child = new EventEmitter();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.send = (_message, callback) => callback?.();
    runner = await createComputerTasks({
      config: () => ({ projects: [grant] }),
      configPath: join(dir, 'device.json'),
      backupDir: join(dir, 'backups'),
      piEntry: 'unused-fixture',
      ledgerFile: join(dir, 'ledger.sqlite'),
      spawnWorker: () => {
        spawned++;
        return child;
      },
      request: async (_config, path, value) => {
        if (path.includes('/jobs/poll')) return { job };
        uploads.push({ path, value });
        return {};
      },
    });
    await runner.poll();
    child.exitCode = 1;
    child.emit('exit', 1, null);
    child.emit('close', 1, null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(uploads.filter((x) => x.path.endsWith('/result')).length, 1);
    assert.equal(uploads.at(-1).value.status, 'error');
    assert.match(uploads.at(-1).value.error, /未自动重放/);
    await runner.poll();
    assert.equal(spawned, 1);
    assert.deepEqual(
      uploads.filter((x) => x.path.endsWith('/result')).map((x) => x.value.status),
      ['error', 'error'],
    );
    await runner.close();
    runner = null;
  } finally {
    await runner?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
