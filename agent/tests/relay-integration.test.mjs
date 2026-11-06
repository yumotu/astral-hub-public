import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../server/index.mjs';
import { localGrant, saveConfig } from '../config.mjs';
import { createComputerTasks } from '../task-runner.mjs';
import { createComputerPluginStore } from '../plugin-store.mjs';
import { createOnlinePackageStore } from '../online-packages.mjs';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (m) =>
  typeof m.content === 'string'
    ? m.content
    : (m.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
test(
  'actual Pi workers stream concurrently, preserve separate native histories, apply supplements once and cancel without replay',
  { timeout: 120000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'astral-computer-integration-')),
      root = join(dir, 'project');
    await mkdir(root);
    await writeFile(join(root, 'README.txt'), 'Actual file tool sentinel ' + randomUUID());
    const binary = Buffer.alloc(3 * 1024 * 1024, 0x61);
    await writeFile(join(root, 'existing-image.png'), binary);
    const calls = [];
    const provider = async (_url, init) => {
      const p = JSON.parse(init.body),
        users = p.messages.filter((m) => m.role === 'user').map(text),
        input = users.at(-1) || '',
        last = p.messages.at(-1);
      calls.push({ users });
      const exportFile = input.includes('EXPORT_FILE');
      const pluginCall = input.includes('PLUGIN_FILE');
      const nativeCall = input.includes('ONLINE_PACKAGE_CALL');
      const appCall = input.includes('APP_FUNCTIONS');
      const ask = input.includes('ASK_USER_NATIVE');
      const longGoal = users.some((u) => u.includes('LONG_GOAL_NATIVE'));
      const checkpoint = p.messages.some(
        (m) => m.role === 'assistant' && text(m).includes('goal checkpoint'),
      );
      const finishGoal =
        longGoal && checkpoint && p.tools.some((t) => t.function.name === 'update_goal');
      const tool =
        finishGoal ||
        (last.role !== 'tool' &&
          (input.includes('READ_FILE') ||
            exportFile ||
            pluginCall ||
            nativeCall ||
            appCall ||
            ask));
      if (ask && last.role === 'tool')
        assert.ok(
          text(last).includes('用户选择乙'),
          'the actual user answer did not reach the original Pi tool result',
        );
      if (appCall)
        assert.ok(
          p.tools.some((t) => t.function.name === 'app_functions'),
          'application tool missing from actual remote Pi schema',
        );
      if (nativeCall)
        assert.ok(
          p.tools.some((t) => t.function.name === 'native_online_fixture'),
          'installed native tool missing from actual model tool schema',
        );
      if (exportFile) {
        assert.ok(
          p.tools.some((t) => t.function.name === 'chat_export'),
          'export tool was absent from actual Pi',
        );
        assert.ok(
          !JSON.stringify(p.messages).includes(binary.subarray(0, 100).toString('base64')),
          'binary data entered model context',
        );
      }
      const chunks =
        longGoal && !finishGoal
          ? [{ role: 'assistant', content: checkpoint ? 'goal completed' : 'goal checkpoint' }]
          : tool
            ? [
                {
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'qa_' + randomUUID(),
                      type: 'function',
                      function: finishGoal
                        ? { name: 'update_goal', arguments: '{"status":"complete"}' }
                        : ask
                          ? {
                              name: 'ask_user',
                              arguments:
                                '{"question":"请选要继续的方案","options":["用户选择甲","用户选择乙"]}',
                            }
                          : appCall
                            ? { name: 'app_functions', arguments: '{"action":"catalog"}' }
                            : nativeCall
                              ? { name: 'native_online_fixture', arguments: '{}' }
                              : pluginCall
                                ? {
                                    name: 'custom_inspect_readme',
                                    arguments: '{"input":"README.txt"}',
                                  }
                                : exportFile
                                  ? {
                                      name: 'chat_export',
                                      arguments: '{"path":"existing-image.png"}',
                                    }
                                  : { name: 'project_read', arguments: '{"path":"README.txt"}' },
                    },
                  ],
                },
              ]
            : Array.from(
                input.includes('HOLD_NATIVE') ? 'x'.repeat(300) : 'synthetic-stream ' + input,
              ).map((content, i) => ({ ...(!i ? { role: 'assistant' } : {}), content }));
      let i = 0,
        timer;
      return new Response(
        new ReadableStream({
          start(c) {
            function send() {
              try {
                if (i < chunks.length) {
                  c.enqueue(
                    new TextEncoder().encode(
                      'data: ' +
                        JSON.stringify({
                          id: 'qa',
                          object: 'chat.completion.chunk',
                          created: 0,
                          model: p.model,
                          choices: [{ index: 0, delta: chunks[i++], finish_reason: null }],
                        }) +
                        '\n\n',
                    ),
                  );
                  timer = setTimeout(send, input.includes('HOLD_NATIVE') ? 100 : 45);
                } else {
                  c.enqueue(
                    new TextEncoder().encode(
                      'data: ' +
                        JSON.stringify({
                          id: 'qa',
                          object: 'chat.completion.chunk',
                          created: 0,
                          model: p.model,
                          choices: [
                            { index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' },
                          ],
                        }) +
                        '\n\ndata: [DONE]\n\n',
                    ),
                  );
                  c.close();
                }
              } catch {
                clearTimeout(timer);
              }
            }
            send();
          },
          cancel() {
            clearTimeout(timer);
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    };
    const token = 'synthetic-native-integration-admin-token-123456';
    const app = await createApp({
      token,
      dataDir: join(dir, 'server'),
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
      const result = await r.json();
      if (!r.ok) throw Error('HTTP ' + r.status + ': ' + result.error);
      return result;
    };
    const owner = await request('/auth/bootstrap', {
      username: 'nativeqa',
      displayName: 'Native QA',
      password: 'Synthetic-native-password',
      adminToken: token,
    });
    const pair = await request('/relay/pairing', {}, owner.token);
    const device = await request('/relay/device/enroll', {
      code: pair.code,
      name: 'Native runtime',
      platform: process.platform,
      rootLabel: 'project',
      allowWrite: false,
    });
    const grant = await localGrant(root),
      config = { ...device, server: base, projects: [grant] },
      configPath = join(dir, 'device.json');
    await saveConfig(configPath, config, { create: true });
    await request(
      '/relay/device/workspace/announce',
      {
        version: 2,
        projects: [{ id: grant.id, name: 'project', allowWrite: false, allowExecute: false }],
      },
      device.token,
    );
    const piEntry = resolve(
      dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))),
      'cli.js',
    );
    const runner = await createComputerTasks({
      config: () => config,
      configPath,
      backupDir: join(dir, 'backups'),
      piEntry,
      ledgerFile: join(dir, 'jobs.sqlite'),
      request: (_config, path, data) => request('/relay' + path, data, device.token),
    });
    t.after(async () => {
      await runner.close();
      app.server.closeAllConnections();
      await new Promise((r) => app.server.close(r));
      await rm(dir, { recursive: true, force: true });
    });
    const submit = (conversationId, input, preference = 'steer') => ({
      id: randomUUID(),
      deviceId: device.deviceId,
      projectId: grant.id,
      conversationId,
      input,
      access: 'read',
      execute: false,
      deliveryPreference: preference,
    });
    const a = submit(randomUUID(), 'READ_FILE A_' + randomUUID()),
      b = submit(randomUUID(), 'B_' + randomUUID());
    for (const p of [a, b]) await request('/relay/submissions', p, owner.token);
    let concurrent = false,
      streamed = false,
      addition,
      results = [],
      lastPoll = 0;
    async function pollUntil(inputs, check) {
      for (let i = 0; i < 250; i++) {
        // Match the real executor's polling cadence; status sampling can remain
        // frequent without exhausting the device's 120/minute claim quota.
        if (Date.now() - lastPoll >= 1000) {
          lastPoll = Date.now();
          await runner.poll();
        }
        results = await Promise.all(
          inputs.map(
            async (p) => (await request('/relay/jobs/' + p.id, undefined, owner.token)).job,
          ),
        );
        concurrent ||= results.length > 1 && results.every((j) => j.status === 'running');
        streamed ||= results.some((j) => j.status === 'running' && !!j.output);
        if (!addition && results[0]?.status === 'running' && results[0]?.output) {
          addition = submit(a.conversationId, 'SUPPLEMENT_' + randomUUID());
          await request('/relay/submissions', addition, owner.token);
        }
        if (check(results)) return results;
        await pause(250);
      }
      throw Error('Native Pi job timeout: ' + JSON.stringify(results));
    }
    const initial = await pollUntil([a, b], (rows) =>
      rows.every((j) => !['queued', 'running'].includes(j.status)),
    );
    assert.ok(concurrent, 'different native sessions did not execute concurrently');
    assert.ok(streamed, 'no partial output arrived before completion');
    assert.ok(
      initial.every((j) => j.status === 'done'),
      JSON.stringify(initial),
    );
    assert.ok(
      initial[0].tools.some(
        (t) =>
          t.name === 'project_read' &&
          t.status === 'done' &&
          t.output.includes('Actual file tool sentinel'),
      ),
    );
    assert.ok(addition);
    const supplemented = (await request('/relay/jobs/' + addition.id, undefined, owner.token)).job;
    assert.equal(supplemented.status, 'done', JSON.stringify(supplemented));
    assert.equal(
      calls.filter((c) => c.users.at(-1)?.includes(addition.input)).length,
      1,
      'supplement was repeated',
    );
    const follow = submit(a.conversationId, 'FOLLOW_A_' + randomUUID(), 'queue');
    await request('/relay/submissions', follow, owner.token);
    await pollUntil([follow], (rows) =>
      rows.every((j) => !['queued', 'running'].includes(j.status)),
    );
    const resumed = calls.find((c) => c.users.at(-1)?.includes(follow.input));
    assert.ok(
      resumed.users.some((s) => s.includes(a.input)),
      'native history did not resume',
    );
    assert.ok(
      !resumed.users.some((s) => s.includes(b.input)),
      'another conversation leaked into this native session',
    );
    const before = calls.length;
    await request('/relay/submissions', follow, owner.token);
    await runner.poll();
    await pause(200);
    assert.equal(calls.length, before, 'duplicate submission invoked the model');
    const appCall = submit(randomUUID(), 'APP_FUNCTIONS_' + randomUUID());
    await request('/relay/submissions', appCall, owner.token);
    const [appResult] = await pollUntil(
      [appCall],
      (rows) => !['queued', 'running'].includes(rows[0].status),
    );
    assert.equal(appResult.status, 'done', JSON.stringify(appResult));
    assert.ok(
      appResult.tools.some(
        (t) =>
          t.name === 'app_functions' &&
          t.status === 'done' &&
          t.output.includes('contacts.send') &&
          t.output.includes('learning.generate'),
      ),
      JSON.stringify(appResult),
    );
    const questionJob = submit(randomUUID(), 'ASK_USER_NATIVE_' + randomUUID());
    await request('/relay/submissions', questionJob, owner.token);
    const [questionState] = await pollUntil([questionJob], (rows) =>
      rows[0].uiRequests?.some((q) => q.status === 'pending'),
    );
    assert.equal(questionState.phase, '等待你的回复');
    const question = questionState.uiRequests.find((q) => q.status === 'pending');
    const pendingQuestions = await request(
      '/relay/device/workspace/jobs/' + questionJob.id + '/app-functions',
      {
        action: 'invoke',
        name: 'assistant.questions',
        input: {},
        callId: 'inspect-current-question',
      },
      device.token,
    );
    assert.equal(pendingQuestions.result.questions[0].id, question.id);
    const beforeAnswer = calls.length;
    await pause(650);
    assert.equal(calls.length, beforeAnswer, 'Pi continued without a user answer');
    const redisplayed = (
      await request('/relay/conversations/' + questionJob.conversationId, undefined, owner.token)
    ).jobs;
    assert.equal(
      redisplayed[0].uiRequests[0].id,
      question.id,
      'a remounted chat lost its pending question',
    );
    await request(
      '/relay/jobs/' + questionJob.id + '/ui',
      { id: question.id, value: '用户选择乙' },
      owner.token,
    );
    const [answered] = await pollUntil(
      [questionJob],
      (rows) => rows[0].status === 'done' || rows[0].status === 'error',
    );
    assert.equal(answered.status, 'done', JSON.stringify(answered));
    assert.equal(answered.uiRequests[0].status, 'resolved');
    assert.equal(answered.tools.filter((t) => t.name === 'ask_user').length, 1);
    const goalJob = submit(randomUUID(), '/long-goal LONG_GOAL_NATIVE verify the saved goal state');
    await request('/relay/submissions', goalJob, owner.token);
    const [goalResult] = await pollUntil(
      [goalJob],
      (rows) => !['running', 'queued'].includes(rows[0].status),
    );
    assert.equal(goalResult.status, 'done', JSON.stringify(goalResult));
    assert.equal(goalResult.longGoal.status, 'complete');
    assert.equal(goalResult.longGoal.tokenBudget, null);
    assert.equal(goalResult.tools.filter((t) => t.name === 'update_goal').length, 1);
    assert.equal(goalResult.output, 'goal completed');
    const statusJob = submit(goalJob.conversationId, '/long-goal status');
    const callsBeforeStatus = calls.length;
    await request('/relay/submissions', statusJob, owner.token);
    const [goalStatus] = await pollUntil(
      [statusJob],
      (rows) => !['running', 'queued'].includes(rows[0].status),
    );
    assert.equal(goalStatus.status, 'done', JSON.stringify(goalStatus));
    assert.equal(goalStatus.longGoal.status, 'complete');
    assert.equal(calls.length, callsBeforeStatus, 'status-only command called the model');
    const delivery = submit(randomUUID(), 'EXPORT_FILE_' + randomUUID());
    await request('/relay/submissions', delivery, owner.token);
    const [delivered] = await pollUntil(
      [delivery],
      (rows) => !['queued', 'running'].includes(rows[0].status),
    );
    assert.equal(delivered.status, 'done', JSON.stringify(delivered));
    assert.equal(delivered.artifacts.length, 1);
    assert.ok(
      delivered.tools.some((t) => t.name === 'chat_export' && t.status === 'done'),
      JSON.stringify(delivered),
    );
    const download = await fetch(
      base +
        '/api/pi/conversations/' +
        delivery.conversationId +
        '/files/' +
        delivered.artifacts[0].id,
      { headers: { Authorization: 'Bearer ' + owner.token } },
    );
    assert.equal(download.status, 200);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), binary);
    await createComputerPluginStore(configPath).apply(grant, {
      kind: 'plugin_register',
      expectedHash: 'new',
      enabled: true,
      manifest: {
        version: 1,
        id: 'inspect_readme',
        name: '检查说明',
        description: '读取并检查项目说明文件。',
        inputLabel: '相对路径',
        steps: [
          { tool: 'project_read', arguments: { path: '{{input}}' } },
          { tool: 'project_stat', arguments: { path: '{{step0.path}}' } },
        ],
      },
    });
    const custom = submit(randomUUID(), 'PLUGIN_FILE_' + randomUUID());
    await request('/relay/submissions', custom, owner.token);
    const [usedPlugin] = await pollUntil(
      [custom],
      (rows) => !['queued', 'running'].includes(rows[0].status),
    );
    assert.equal(usedPlugin.status, 'done', JSON.stringify(usedPlugin));
    assert.ok(
      usedPlugin.tools.some(
        (t) =>
          t.name === 'custom_inspect_readme' &&
          t.status === 'done' &&
          t.output.includes('Actual file tool sentinel'),
      ),
      JSON.stringify(usedPlugin),
    );
    grant.allowExecute = true;
    await saveConfig(configPath, config);
    await request(
      '/relay/device/workspace/announce',
      {
        version: 2,
        projects: [{ id: grant.id, name: 'project', allowWrite: false, allowExecute: true }],
      },
      device.token,
    );
    const integrity = 'sha512-' + Buffer.alloc(64, 8).toString('base64');
    const packages = createOnlinePackageStore(configPath, {
      fetch: async () =>
        Response.json({ name: 'synthetic-native-online', version: '1.0.0', dist: { integrity } }),
      install: async (candidate) => {
        const root = join(candidate, 'node_modules/synthetic-native-online');
        await mkdir(root, { recursive: true });
        await writeFile(
          join(root, 'package.json'),
          JSON.stringify({
            name: 'synthetic-native-online',
            version: '1.0.0',
            type: 'module',
            pi: { extensions: ['index.mjs'] },
          }),
        );
        await writeFile(
          join(root, 'index.mjs'),
          "export default pi=>pi.registerTool({name:'native_online_fixture',label:'Online',description:'Installed native fixture',parameters:{type:'object',properties:{},additionalProperties:false},async execute(){return {content:[{type:'text',text:'real installed native result'}]};}})",
        );
        await writeFile(
          join(candidate, 'package-lock.json'),
          JSON.stringify({ packages: { 'node_modules/synthetic-native-online': { integrity } } }),
        );
      },
    });
    await packages.apply(grant, {
      kind: 'package_install',
      package: { name: 'synthetic-native-online', version: '1.0.0', integrity },
      expectedRevision: 'new',
    });
    const native = {
      ...submit(randomUUID(), 'ONLINE_PACKAGE_CALL_' + randomUUID()),
      execute: true,
    };
    await request('/relay/submissions', native, owner.token);
    const [usedNative] = await pollUntil(
      [native],
      (rows) => !['queued', 'running'].includes(rows[0].status),
    );
    assert.equal(usedNative.status, 'done', JSON.stringify(usedNative));
    assert.ok(
      usedNative.tools.some(
        (t) =>
          t.name === 'native_online_fixture' &&
          t.status === 'done' &&
          t.output.includes('real installed native result'),
      ),
      JSON.stringify(usedNative),
    );
    const hold = submit(randomUUID(), 'HOLD_NATIVE_' + randomUUID());
    await request('/relay/submissions', hold, owner.token);
    await pollUntil([hold], (rows) => rows[0].status === 'running' && rows[0].output);
    await request('/relay/jobs/' + hold.id + '/cancel', {}, owner.token);
    await pause(2500);
    assert.equal(
      (await request('/relay/jobs/' + hold.id, undefined, owner.token)).job.status,
      'cancelled',
    );
    console.log(
      'Actual Pi workers: concurrency, file tool, partial output, native resume, steering and cancellation verified with synthetic model SSE.',
    );
  },
);
