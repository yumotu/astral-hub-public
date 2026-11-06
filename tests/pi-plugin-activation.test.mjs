import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pluginLoadPlan } from '../deploy/pi/plugin-load-plan.mjs';
import { runtimeDiagnostic, cleanDiagnostic } from '../deploy/pi/runtime-diagnostics.mjs';
import { startRpcSession } from '../deploy/pi/rpc-startup.mjs';
import {
  changePackages,
  recoverPackages,
  recoverPackagesForTurn,
} from '../deploy/pi/package-transaction.mjs';

test('managed web, cron and notification adapters each load once with all other native plugins', () => {
  const root = '/home/node/.pi/agent/astral/packages/npm/node_modules/';
  const native = root + 'pi-subagents/bundle/index.js';
  const plan = pluginLoadPlan(
    {
      extensions: [
        root + 'pi-web-access/dist/index.js',
        root + '@patimweb/pi-cron/index.ts',
        root + 'pi-notify/index.js',
        native,
        native,
      ],
      skills: ['/s'],
      prompts: ['/p'],
      themes: ['/t'],
    },
    { owner: true, cronRoot: root + '@patimweb/pi-cron' },
  );
  assert.equal(plan.extensions.filter((p) => p.endsWith('/web-tools.mjs')).length, 1);
  assert.equal(plan.extensions.filter((p) => p.endsWith('/cron-tools.mjs')).length, 1);
  assert.equal(plan.extensions.filter((p) => p === native).length, 1);
  assert.ok(!plan.extensions.some((p) => p.endsWith('/pi-web-access/dist/index.js')));
  assert.ok(!plan.extensions.some((p) => p.endsWith('/pi-notify/index.js')));
  assert.ok(plan.extensions.includes('/bridge/package-tools.mjs'));
  assert.deepEqual(plan.skills, ['/s']);
  const fallback = pluginLoadPlan(
    { extensions: [native], skills: ['/s'] },
    { owner: true, coreOnly: true },
  );
  assert.ok(!fallback.extensions.includes(native));
  assert.deepEqual(fallback.skills, []);
  assert.ok(fallback.extensions.includes('/bridge/package-tools.mjs'));
  const different = pluginLoadPlan(
    { extensions: [root + 'other-pi-web-access/index.js'] },
    { owner: true },
  );
  assert.ok(different.extensions.includes(root + 'other-pi-web-access/index.js'));
});

test('startup conflicts retain actionable bounded diagnostics and redact credentials', () => {
  const text =
    'Error: Failed to load extension "/packages/pi-web-access/dist/index.js": Tool "web_search" conflicts with /bridge/web-tools.mjs';
  const d = runtimeDiagnostic(new Error('Process exited'), {
    stderr: text,
    exitCode: 1,
    phase: 'startup',
  });
  assert.equal(d.code, 'extension_conflict');
  assert.match(d.message, /web_search/);
  assert.match(d.details, /pi-web-access/);
  assert.equal(d.exitCode, 1);
  assert.ok(runtimeDiagnostic(new Error('x'.repeat(50000))).details.length <= 12000);
  const clean = cleanDiagnostic(
    '\x1b[31mBearer abcdefghijklmnopqrstuvwxyz\x1b[0m\npassword=some-secret-value\n' +
      'sk-' +
      'z'.repeat(32),
    { ASTRAL_HOST_ACCESS_TOKEN: 'some-secret-value' },
  );
  assert.ok(!clean.includes('abcdefghijklmnopqrstuvwxyz'));
  assert.ok(!clean.includes('some-secret-value'));
  assert.ok(!clean.includes('z'.repeat(32)));
  assert.ok(!clean.includes('\x1b'));
});

test('late extension failure after SDK spawn is caught before any prompt and falls back only after an RPC handshake', async () => {
  const events = [],
    warnings = [];
  const conflict = 'Tool "web_search" conflicts with /bridge/web-tools.mjs';
  const native = {
    async start() {
      events.push('spawn-native');
    },
    async getState() {
      await new Promise((r) => setImmediate(r));
      events.push('native-exited');
      throw new Error(conflict);
    },
    getStderr: () => conflict,
    async stop() {
      events.push('stop-native');
    },
  };
  const core = {
    async start() {
      events.push('spawn-core');
    },
    async getState() {
      events.push('core-rpc-ready');
      return {};
    },
    getStderr: () => '',
  };
  assert.equal(
    await startRpcSession(native, {
      canFallback: true,
      fallback: () => core,
      onWarning: (d) => {
        events.push('warning');
        warnings.push(d);
      },
    }),
    core,
  );
  assert.deepEqual(events, [
    'spawn-native',
    'native-exited',
    'stop-native',
    'spawn-core',
    'core-rpc-ready',
    'warning',
  ]);
  assert.equal(warnings[0].code, 'extension_conflict');
  let fallback = false;
  await assert.rejects(
    startRpcSession(native, {
      canFallback: false,
      fallback: () => {
        fallback = true;
        return core;
      },
    }),
    /web_search/,
  );
  assert.equal(
    fallback,
    false,
    'activation checks must reject broken packages instead of passing the core fallback',
  );
});

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'astral-package-activation-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'packages');
  await mkdir(join(root, 'npm'), { recursive: true });
  await writeFile(join(root, 'settings.json'), '{"packages":["npm:working@1"]}');
  await writeFile(join(root, 'npm', 'dependency.js'), 'version-one');
  return root;
}
test('failed activation leaves both configured sources and dependency bytes unchanged', async (t) => {
  const root = await fixture(t);
  await assert.rejects(
    changePackages(root, {
      mutate: async (candidate) => {
        await writeFile(join(candidate, 'settings.json'), '{"packages":["npm:broken@2"]}');
        await writeFile(join(candidate, 'npm', 'dependency.js'), 'version-two');
      },
      validate: async () => {
        throw new Error('Tool "web_search" conflicts with core');
      },
    }),
    /conflicts/,
  );
  assert.match(await readFile(join(root, 'settings.json'), 'utf8'), /working@1/);
  assert.equal(await readFile(join(root, 'npm', 'dependency.js'), 'utf8'), 'version-one');
});
test('validated activation swaps the complete tree, retains last version and rejects concurrent changes', async (t) => {
  const root = await fixture(t);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const first = changePackages(root, {
    mutate: async (candidate) => {
      await writeFile(join(candidate, 'npm', 'dependency.js'), 'version-two');
      await gate;
    },
    validate: async () => ({ ready: true, extensions: 15 }),
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  await assert.rejects(
    changePackages(root, { mutate: async () => {}, validate: async () => ({ ready: true }) }),
    /另一个插件/,
  );
  release();
  assert.equal((await first).ready, true);
  assert.equal(await readFile(join(root, 'npm', 'dependency.js'), 'utf8'), 'version-two');
  assert.equal(
    await readFile(join(root + '.previous', 'npm', 'dependency.js'), 'utf8'),
    'version-one',
  );
});
test('cancellation and interrupted commit recover the previous usable tree', async (t) => {
  const root = await fixture(t);
  const controller = new AbortController();
  await assert.rejects(
    changePackages(root, {
      signal: controller.signal,
      mutate: async () => {
        controller.abort();
      },
      validate: async () => ({ ready: true }),
    }),
    /取消/,
  );
  assert.equal(await readFile(join(root, 'npm', 'dependency.js'), 'utf8'), 'version-one');
  const candidate = root + '.candidate-test';
  await mkdir(candidate);
  await writeFile(root + '.transaction.json', JSON.stringify({ candidate }));
  await rename(root, root + '.previous');
  await recoverPackages(root);
  assert.equal(await readFile(join(root, 'npm', 'dependency.js'), 'utf8'), 'version-one');
});

test('a killed installer does not leave a permanent lock or candidate directory', async (t) => {
  const root = await fixture(t),
    candidate = root + '.candidate-crashed';
  await mkdir(root + '.lock');
  await writeFile(root + '.lock/owner.json', JSON.stringify({ pid: 2147483647 }));
  await mkdir(candidate);
  await writeFile(root + '.transaction.json', JSON.stringify({ candidate }));
  await changePackages(root, { mutate: async () => {}, validate: async () => ({ ready: true }) });
  assert.equal(await readFile(join(root, 'npm', 'dependency.js'), 'utf8'), 'version-one');
  await assert.rejects(readFile(join(candidate, 'settings.json')), { code: 'ENOENT' });
});

test('the next turn recovers an interrupted swap without clearing a live installer lock', async (t) => {
  const root = await fixture(t),
    candidate = root + '.candidate-stopped-turn';
  await mkdir(root + '.lock');
  await writeFile(root + '.lock/owner.json', JSON.stringify({ pid: process.pid }));
  await assert.rejects(recoverPackagesForTurn(root), { status: 429 });
  await writeFile(root + '.lock/owner.json', JSON.stringify({ pid: 2147483647 }));
  await mkdir(candidate);
  await writeFile(root + '.transaction.json', JSON.stringify({ candidate }));
  await rename(root, root + '.previous');
  await recoverPackagesForTurn(root);
  assert.equal(await readFile(join(root, 'npm', 'dependency.js'), 'utf8'), 'version-one');
});
