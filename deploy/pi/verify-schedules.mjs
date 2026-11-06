// Model-free integration checks for the real pinned cron host; never use a live
// user's home or production volumes. Called from disposable runtime acceptance.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

export async function verifySchedules(
  base,
  packageRoot = '/extensions/node_modules/@patimweb/pi-cron',
) {
  await mkdir(base, { recursive: true, mode: 0o700 });
  const ownerId = randomUUID();
  let child,
    reader,
    pending,
    exited,
    diagnostic = '';
  async function start() {
    pending = new Map();
    exited = false;
    child = spawn(process.execPath, [fileURLToPath(new URL('./cron-host.mjs', import.meta.url))], {
      env: {
        PATH: process.env.PATH,
        HOME: base,
        PI_CODING_AGENT_DIR: base,
        PI_CRON_HOME: join(base, 'cron'),
        ASTRAL_CRON_PACKAGE: packageRoot,
        ASTRAL_OWNER_ID: ownerId,
        TZ: 'Asia/Shanghai',
        NODE_OPTIONS: '--max-old-space-size=160',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    reader = createInterface({ input: child.stdout });
    child.stderr.on('data', (data) => {
      diagnostic = (diagnostic + data).slice(-2000);
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error('cron host startup timeout: ' + diagnostic)),
        20000,
      );
      const fail = () => {
        exited = true;
        clearTimeout(timer);
        reject(Error('cron host exited: ' + diagnostic));
        for (const call of pending.values()) call.reject(Error('cron host exited'));
        pending.clear();
      };
      child.once('error', fail);
      child.once('exit', fail);
      reader.on('line', (line) => {
        const data = JSON.parse(line);
        if (data.type === 'ready') {
          clearTimeout(timer);
          resolve();
        }
        const call = pending.get(data.id);
        if (call) {
          pending.delete(data.id);
          data.error ? call.reject(Error(data.error)) : call.resolve(data.result);
        }
      });
    });
  }
  function request(data) {
    return new Promise((resolve, reject) => {
      const id = randomUUID(),
        timer = setTimeout(() => {
          pending.delete(id);
          reject(Error('cron request timeout'));
        }, 15000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin.write(JSON.stringify({ ...data, id }) + '\n');
    });
  }
  async function stop() {
    if (!child || exited) return;
    const done = new Promise((resolve) => child.once('exit', resolve));
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    await done;
    clearTimeout(timer);
    reader.close();
  }
  const server = {
    ownerId,
    conversationId: randomUUID(),
    projectId: null,
    access: 'read',
    thinkingLevel: 'off',
    timeZone: 'Asia/Shanghai',
    cwd: base,
    model: 'synthetic-only',
    toolNames: null,
    skills: [],
    target: { kind: 'server' },
  };
  const computer = {
    ...server,
    conversationId: randomUUID(),
    projectId: randomUUID(),
    access: 'edit',
    target: { kind: 'computer', deviceId: randomUUID(), execute: true },
  };
  const tool = (context, name, params, callId = randomUUID()) =>
    request({ action: 'tool', context, name, params, callId });
  try {
    await start();
    const a = await tool(server, 'cron_create', {
      name: 'server-once',
      prompt: 'Inspect synthetic state',
      schedule: 'in 2s',
      deliver: [],
    });
    const b = await tool(computer, 'cron_create', {
      name: 'computer-goal',
      prompt: '/long-goal Verify synthetic result',
      schedule: 'every 1m',
      deliver: [],
    });
    assert.equal(a.details.job.name, 'server-once');
    assert.equal(b.details.job.name, 'computer-goal');
    assert.equal((await tool(server, 'cron_list', {})).details.jobs.length, 1);
    assert.equal((await tool(computer, 'cron_list', {})).details.jobs[0].id, b.details.job.id);
    const reduced = { ...computer, access: 'read', target: { ...computer.target, execute: false } };
    await tool(reduced, 'cron_update', { job: b.details.job.id, enabled: false });
    assert.equal((await tool(reduced, 'cron_list', {})).details.jobs[0].enabled, false);
    await assert.rejects(
      tool(reduced, 'cron_update', { job: b.details.job.id, enabled: true }),
      /项目与模式/,
    );
    await tool(computer, 'cron_update', { job: b.details.job.id, enabled: true });
    await assert.rejects(tool(server, 'cron_run', { job: b.details.job.id }), /当前对话/);
    const manualId = randomUUID();
    await tool(computer, 'cron_run', { job: b.details.job.id }, manualId);
    await tool(computer, 'cron_run', { job: b.details.job.id }, manualId);
    let runs = [];
    for (let i = 0; i < 50; i++) {
      runs = (await request({ action: 'pending' })).runs;
      if (runs.length === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(
      runs.length,
      2,
      'actual scheduled one-shot or manual occurrence missing/duplicated',
    );
    const remote = runs.find((r) => r.jobId === b.details.job.id);
    assert.deepEqual(remote.target, computer.target);
    assert.equal(remote.toolAllowlist, null);
    assert.match(remote.input, /^\/long-goal /);
    const ids = runs.map((r) => r.id).sort();
    await stop();
    await start();
    assert.deepEqual(
      (await request({ action: 'pending' })).runs.map((r) => r.id).sort(),
      ids,
      'restart replayed or lost an occurrence',
    );
    for (const run of runs)
      await request({
        action: 'ack',
        run: {
          ownerId,
          id: run.id,
          status: run.id === remote.id ? 'error' : 'done',
          output: 'synthetic result',
          finishedAt: new Date().toISOString(),
          ...(run.id === remote.id
            ? { disablePlan: true, error: 'synthetic authorization revoked' }
            : {}),
        },
      });
    assert.equal((await tool(computer, 'cron_list', {})).details.jobs[0].enabled, false);
    assert.equal((await tool(computer, 'cron_results', {})).details.runs.length, 1);
    assert.equal((await request({ action: 'pending' })).runs.length, 0);
    return {
      realPinnedCron: true,
      actualTimedOccurrence: true,
      computerScopePersisted: true,
      scopesIsolated: true,
      restartWithoutReplay: true,
      revocationDisablesPlan: true,
    };
  } finally {
    await stop();
  }
}
