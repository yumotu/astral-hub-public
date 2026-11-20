import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { RpcClient } from '@earendil-works/pi-coding-agent';
import { promptAndSettle, longGoalEvent } from '../assets/rpc-prompt.mjs';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

test(
  'real Pi RPC goal commands continue through settlement, complete, and pause after a killed worker without widening tools',
  { timeout: 60000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'astral-long-goal-')),
      sessionDir = join(dir, 'sessions'),
      agentDir = join(dir, 'agent');
    await mkdir(sessionDir);
    await mkdir(agentDir);
    let mode = 'finish',
      calls = 0,
      client,
      goal,
      events = [];
    const premature = new Set();
    const provider = createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks));
      calls++;
      if (mode === 'pause') await pause(150);
      assert.ok(
        body.tools.every((t) =>
          ['create_goal', 'get_goal', 'update_goal', 'goal_plan'].includes(t.function.name),
        ),
        'goal adapter widened the allowed tools',
      );
      const last = body.messages.at(-1);
      if (calls > 30) {
        res.writeHead(500);
        res.end('fixture stopped an unexpected loop');
        return;
      }
      let next;
      if (['finish', 'hold'].includes(mode) && goal?.status === 'active') {
        const plan = goal.plan;
        if (
          !plan ||
          (mode === 'finish' &&
            plan.items.some((v) => v.status !== 'done') &&
            premature.has(goal.id))
        ) {
          const done = !!plan;
          next = {
            name: 'goal_plan',
            arguments: JSON.stringify({
              revision: plan?.revision || 0,
              criteria: ['Synthetic acceptance'],
              items: [
                {
                  id: 'verify',
                  text: 'Verify synthetic result',
                  status: done ? 'done' : 'pending',
                  ...(done
                    ? {
                        evidence:
                          'Synthetic provider returned expected output; fixture asserted result',
                      }
                    : {}),
                },
              ],
              verification: done
                ? [
                    {
                      criterion: 'Synthetic acceptance',
                      evidence: 'Fixture output matched expected result',
                    },
                  ]
                : [],
            }),
          };
        } else if (mode === 'finish') {
          premature.add(goal.id);
          next = { name: 'update_goal', arguments: '{"status":"complete"}' };
        }
      }
      const tool = !!next;
      const delta = tool
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'goal_' + randomUUID(),
                type: 'function',
                function: next,
              },
            ],
          }
        : {
            role: 'assistant',
            content:
              mode === 'ordinary'
                ? 'ordinary only'
                : last.role === 'tool'
                  ? 'verified complete'
                  : 'first checkpoint',
          };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(
        'data: ' +
          JSON.stringify({
            id: 'goal-fixture',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'goal-fixture',
            choices: [{ index: 0, delta, finish_reason: null }],
          }) +
          '\n\ndata: ' +
          JSON.stringify({
            id: 'goal-fixture',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'goal-fixture',
            choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }],
            usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
          }) +
          '\n\ndata: [DONE]\n\n',
      );
    });
    await new Promise((r) => provider.listen(0, '127.0.0.1', r));
    await writeFile(
      join(agentDir, 'models.json'),
      JSON.stringify({
        providers: {
          'goal-qa': {
            baseUrl: 'http://127.0.0.1:' + provider.address().port + '/v1',
            api: 'openai-completions',
            apiKey: 'synthetic-only',
            models: [
              {
                id: 'goal-fixture',
                input: ['text'],
                reasoning: false,
                contextWindow: 128000,
                maxTokens: 4096,
              },
            ],
          },
        },
      }),
      { mode: 0o600 },
    );
    const start = async (session, allowed = '1') => {
      const args = [
        ...(session ? ['--session', session] : ['--session-id', randomUUID()]),
        '--session-dir',
        sessionDir,
        '--no-builtin-tools',
        '--tools',
        'create_goal,get_goal,update_goal,goal_plan',
        '--no-mcp',
        '--no-extensions',
        '--extension',
        fileURLToPath(new URL('../assets/long-goal.mjs', import.meta.url)),
        '--no-skills',
        '--no-prompt-templates',
        '--no-themes',
        '--no-context-files',
        '--no-approve',
        '--offline',
      ];
      client = new RpcClient({
        cliPath: resolve(
          dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))),
          'cli.js',
        ),
        cwd: dir,
        args,
        provider: 'goal-qa',
        model: 'goal-fixture',
        env: {
          PI_CODING_AGENT_DIR: agentDir,
          PI_OFFLINE: '1',
          PI_TELEMETRY: '0',
          ASTRAL_LONG_GOAL_ALLOWED: allowed,
        },
      });
      client.onEvent((e) => {
        events.push(e);
        const g = longGoalEvent(e);
        if (g) goal = g.goal;
      });
      await client.start();
      await client.getState();
      return client;
    };
    const sessionFile = async () =>
      join(sessionDir, (await readdir(sessionDir)).filter((n) => n.endsWith('.jsonl')).at(-1));
    t.after(async () => {
      await client?.stop().catch(() => {});
      provider.closeAllConnections();
      await new Promise((r) => provider.close(r));
      await rm(dir, { recursive: true, force: true });
    });
    await start();
    assert.ok((await client.getCommands()).some((c) => c.name === 'long-goal'));
    assert.equal(
      await promptAndSettle(
        client,
        '/long-goal Verify the native continuation fixture',
        undefined,
        15000,
      ),
      'handled',
    );
    assert.equal(
      calls,
      5,
      'native handled response ended before a continuation and actual completion',
    );
    assert.equal(goal.status, 'complete');
    assert.equal(goal.tokenBudget, null);
    assert.ok(goal.tokensUsed > 0);
    assert.equal(goal.plan.revision, 2);
    assert.ok(goal.plan.items.every((v) => v.status === 'done'));
    assert.ok(
      events.some(
        (e) => e.type === 'tool_execution_end' && e.toolName === 'update_goal' && e.isError,
      ),
      'premature completion was not blocked',
    );
    const native = await sessionFile();
    await client.stop();
    // Start a new explicitly requested goal, then kill its worker as a daemon crash.
    mode = 'hold';
    calls = 0;
    events = [];
    await start(native);
    const work = promptAndSettle(
      client,
      '/long-goal Preserve this unfinished goal across a crash',
      undefined,
      15000,
    );
    work.catch(() => {});
    for (let i = 0; i < 200; i++) {
      const saved = (await readFile(native, 'utf8'))
        .split('\n')
        .flatMap((l) => {
          try {
            return [JSON.parse(l)];
          } catch {
            return [];
          }
        })
        .filter((e) => e.type === 'custom' && e.customType === 'pi-goal')
        .at(-1)?.data?.goal;
      if (saved?.status === 'active' && goal.plan?.revision === 1 && calls >= 1) break;
      await pause(20);
    }
    assert.equal(goal.status, 'active');
    client.process.kill('SIGKILL');
    await assert.rejects(work, /进程已退出/);
    await client.stop().catch(() => {});
    const before = calls;
    await start(native);
    assert.equal(goal.status, 'paused', 'a fresh process silently restored an active loop');
    assert.equal(goal.plan.revision, 1, 'restart lost the saved TODO');
    mode = 'ordinary';
    await promptAndSettle(
      client,
      'An ordinary message is not a request to resume the goal',
      undefined,
      15000,
    );
    assert.equal(calls, before + 1, 'ordinary prompt resumed a paused goal');
    const savedGoalId = goal.id;
    mode = 'finish';
    await promptAndSettle(client, '/long-goal resume', undefined, 15000);
    assert.equal(goal.id, savedGoalId, 'explicit resume replaced the saved goal');
    assert.equal(goal.status, 'complete');
    mode = 'pause';
    const pauseAt = calls;
    const live = promptAndSettle(client, '/long-goal Check explicit pause', undefined, 15000);
    for (let i = 0; i < 200 && calls === pauseAt; i++) await pause(10);
    assert.equal(goal.status, 'active');
    assert.equal(await client.prompt('/long-goal pause'), 'handled');
    await live;
    assert.equal(goal.status, 'paused', 'live pause did not stop native continuation');
    const afterPause = calls;
    await pause(250);
    assert.equal(calls, afterPause, 'paused goal kept creating model calls');
    await client.stop();
    await start(native, '0');
    assert.ok(
      !(await client.getCommands()).some((c) => c.name === 'long-goal'),
      'a restricted assistance session enabled goal mode',
    );
  },
);
