import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../server/index.mjs';
import { localGrant, saveConfig } from '../config.mjs';
import { localEnvironment } from '../process-tree.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (m) =>
  typeof m.content === 'string'
    ? m.content
    : (m.content || [])
        .filter((x) => x.type === 'text')
        .map((x) => x.text)
        .join('\n');

test(
  'actual daemon crash stops its waiting Pi worker and an explicit answer resumes the same goal once',
  { timeout: 180000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'astral-question-restart-')),
      root = join(dir, 'project');
    await mkdir(root);
    await writeFile(join(root, 'README.txt'), 'Synthetic checkpoint');
    let clock = Date.now(),
      daemon;
    const workerPids = new Set(),
      calls = [],
      generated = [];
    const provider = async (_url, init) => {
      const p = JSON.parse(init.body),
        users = p.messages.filter((m) => m.role === 'user').map(text),
        last = p.messages.at(-1);
      const answered = users.some(
        (s) => s.includes('[用户已明确回答中断任务的问题') && s.includes('Actual recovery answer'),
      );
      calls.push({ users, answered });
      let delta,
        tool = false;
      if (last.role === 'tool' || generated.includes('update_goal'))
        delta = { role: 'assistant', content: 'Verified completion after the real answer' };
      else {
        const name = answered ? 'update_goal' : 'ask_user';
        assert.ok(
          p.tools.some((x) => x.function.name === name),
          'restored native goal tool missing: ' + name,
        );
        generated.push(name);
        tool = true;
        delta = {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'qa_' + randomUUID(),
              type: 'function',
              function: {
                name,
                arguments: JSON.stringify(
                  answered
                    ? { status: 'complete' }
                    : {
                        question: 'Which scope should the goal use?',
                        context: 'Saved checkpoint must be retained',
                        options: ['Scope A', 'Scope B'],
                      },
                ),
              },
            },
          ],
        };
      }
      const chunk = (delta, finish_reason = null) =>
        'data: ' +
        JSON.stringify({
          id: 'qa',
          object: 'chat.completion.chunk',
          model: p.model,
          choices: [{ index: 0, delta, finish_reason }],
        }) +
        '\n\n';
      return new Response(
        chunk(delta) + chunk({}, tool ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    };
    const admin = 'synthetic-question-restart-admin-token-123456';
    const app = await createApp({
      token: admin,
      dataDir: join(dir, 'server'),
      now: () => clock,
      relayFetch: provider,
      aiConfig: { apiKey: 'synthetic-only', model: 'deepseek-flash' },
    });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    const base = 'http://127.0.0.1:' + app.server.address().port;
    const request = async (path, data, auth) => {
      const r = await fetch(base + '/api' + path, {
        method: data ? 'POST' : 'GET',
        headers: {
          ...(auth ? { Authorization: 'Bearer ' + auth } : {}),
          ...(data ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(data ? { body: JSON.stringify(data) } : {}),
        signal: AbortSignal.timeout(20000),
      });
      const body = await r.json();
      assert.ok(r.ok, path + ': ' + JSON.stringify(body));
      return body;
    };
    const owner = await request('/auth/bootstrap', {
      username: 'restartqa',
      displayName: 'Restart QA',
      password: 'Synthetic-restart-password',
      adminToken: admin,
    });
    const device = await request('/relay/device/enroll', {
      code: (await request('/relay/pairing', {}, owner.token)).code,
      name: 'Synthetic native restart',
      platform: process.platform,
      rootLabel: 'project',
      allowWrite: false,
    });
    const grant = await localGrant(root),
      configPath = join(dir, 'device.json');
    await saveConfig(configPath, { ...device, server: base, projects: [grant] }, { create: true });
    await request(
      '/relay/device/workspace/announce',
      {
        version: 2,
        capabilities: ['question_resume'],
        projects: [{ id: grant.id, name: 'project', allowWrite: false, allowExecute: false }],
      },
      device.token,
    );
    const piEntry = resolve(
      dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))),
      'cli.js',
    );
    const daemonFile = join(dir, 'daemon.mjs');
    await writeFile(
      daemonFile,
      [
        `import {createComputerTasks} from ${JSON.stringify(new URL('../task-runner.mjs', import.meta.url).href)};`,
        `import {readFile} from 'node:fs/promises'; import {fork} from 'node:child_process'; import {dirname,join} from 'node:path';`,
        `const configPath=process.argv[2],config=JSON.parse(await readFile(configPath,'utf8'));`,
        `const tasks=await createComputerTasks({config:()=>config,configPath,backupDir:join(dirname(configPath),'backups'),ledgerFile:join(dirname(configPath),'jobs.sqlite'),piEntry:process.argv[3],spawnWorker:(...args)=>{const child=fork(...args);process.send?.({type:'worker',pid:child.pid});return child;},request:async(_config,path,data)=>{const r=await fetch(config.server+'/api/relay'+path,{method:data?'POST':'GET',headers:{Authorization:'Bearer '+config.token,...data?{'Content-Type':'application/json'}:{}},...data?{body:JSON.stringify(data)}:{},signal:AbortSignal.timeout(15000)});const result=await r.json();if(!r.ok)throw Error(result.error);return result;}});`,
        `const timer=setInterval(()=>void tasks.poll().catch(e=>process.send?.({type:'error',error:e.message})),500);`,
        `process.on('message',async p=>{if(p.type==='close'){clearInterval(timer);await tasks.close();if(process.connected)process.disconnect();}}); process.send?.({type:'ready'});`,
      ].join('\n'),
    );
    let diagnostic = '';
    async function start() {
      daemon = fork(daemonFile, [configPath, piEntry], {
        env: localEnvironment(),
        execArgv: [],
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      daemon.stderr.on('data', (x) => (diagnostic = (diagnostic + x).slice(-4000)));
      daemon.on('message', (p) => {
        if (p.type === 'worker') workerPids.add(p.pid);
        if (p.type === 'error') diagnostic = (diagnostic + p.error).slice(-4000);
      });
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(Error('Daemon startup timeout: ' + diagnostic)),
          20000,
        );
        daemon.on('message', (p) => {
          if (p.type === 'ready') {
            clearTimeout(timeout);
            resolve();
          }
        });
        daemon.once('exit', () => {
          clearTimeout(timeout);
          reject(Error('Daemon exited: ' + diagnostic));
        });
      });
    }
    async function stop() {
      if (!daemon || daemon.exitCode !== null || daemon.signalCode !== null) return;
      const old = daemon;
      daemon = null;
      const done = new Promise((resolve) => old.once('exit', resolve));
      old.send({ type: 'close' }, () => {});
      const timer = setTimeout(() => old.kill('SIGKILL'), 4000);
      await done;
      clearTimeout(timer);
    }
    t.after(async () => {
      await stop();
      for (const pid of workerPids)
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      app.server.closeAllConnections();
      await new Promise((r) => app.server.close(r));
      await rm(dir, { recursive: true, force: true });
    });
    async function waitJob(id, check) {
      for (let i = 0; i < 500; i++) {
        const { job } = await request('/relay/jobs/' + id, null, owner.token);
        if (check(job)) return job;
        if (['error', 'cancelled', 'interrupted', 'done'].includes(job.status))
          throw Error('Native phase ended before the required state: ' + JSON.stringify(job));
        await sleep(100);
      }
      throw Error('Native continuation timeout: ' + diagnostic);
    }
    const original = {
      id: randomUUID(),
      deviceId: device.deviceId,
      projectId: grant.id,
      conversationId: randomUUID(),
      input: '/long-goal Verify saved work after the user specifies scope',
      access: 'read',
      execute: false,
    };
    await request('/relay/submissions', original, owner.token);
    await start();
    const waiting = await waitJob(original.id, (j) =>
      j.uiRequests?.some((q) => q.status === 'pending'),
    );
    const q = waiting.uiRequests.find((q) => q.status === 'pending');
    assert.equal(q.source, 'ask_user');
    assert.equal(waiting.longGoal.status, 'active');
    const oldDaemon = daemon;
    daemon = null;
    const crashed = new Promise((resolve) => oldDaemon.once('exit', resolve));
    oldDaemon.kill('SIGKILL');
    await crashed;
    for (let i = 0; i < 100; i++) {
      let live = false;
      for (const pid of workerPids)
        try {
          process.kill(pid, 0);
          live = true;
        } catch {}
      if (!live) break;
      await sleep(100);
    }
    for (const pid of workerPids)
      assert.throws(
        () => process.kill(pid, 0),
        undefined,
        'crashed daemon left an orphan Pi worker',
      );
    workerPids.clear();
    clock += 60000;
    assert.equal(
      (await request('/relay/jobs/' + original.id, null, owner.token)).job.status,
      'interrupted',
    );
    const countBeforeAnswer = calls.length;
    const reply = { id: q.id, value: 'Actual recovery answer' };
    const { job: next } = await request(
      '/relay/jobs/' + original.id + '/question-resume',
      reply,
      owner.token,
    );
    assert.notEqual(next.id, original.id);
    assert.equal(next.resumeQuestion.goalId, waiting.longGoal.id);
    assert.equal(
      calls.length,
      countBeforeAnswer,
      'an answer was executed before an explicit daemon restart',
    );
    await start();
    const completed = await waitJob(next.id, (j) => !['queued', 'running'].includes(j.status));
    assert.equal(completed.status, 'done', JSON.stringify(completed));
    assert.equal(completed.longGoal.id, waiting.longGoal.id);
    assert.equal(completed.longGoal.status, 'complete');
    assert.deepEqual(generated, ['ask_user', 'update_goal'], 'old tool or task was replayed');
    assert.ok(calls.some((c) => c.answered));
    const beforeRetry = calls.length;
    assert.equal(
      (await request('/relay/jobs/' + original.id + '/question-resume', reply, owner.token)).job.id,
      next.id,
    );
    await sleep(600);
    assert.equal(calls.length, beforeRetry);
    assert.equal(
      (await request('/relay/jobs/' + original.id, null, owner.token)).job.status,
      'interrupted',
    );
    const sessionDir = join(dir, 'sessions', device.deviceId, grant.id, original.conversationId);
    const logs = (await readdir(sessionDir)).filter((x) => x.endsWith('.jsonl'));
    assert.equal(logs.length, 1, 'continuation replaced the native history');
    const entries = (await readFile(join(sessionDir, logs[0]), 'utf8'))
      .trim()
      .split('\n')
      .map((x) => JSON.parse(x));
    assert.equal(
      entries.filter((x) => x.customType === 'astral-question' && x.data?.status === 'pending')
        .length,
      1,
    );
    console.log(
      'Actual daemon restart: orphan stopped, explicit answer bound to original goal and native history, no repeated ask or external operation.',
    );
  },
);
