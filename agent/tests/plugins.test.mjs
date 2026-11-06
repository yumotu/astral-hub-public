import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { localGrant, saveConfig } from '../config.mjs';
import { createComputerPluginStore } from '../plugin-store.mjs';
import registerTools from '../computer-tools.mjs';
const plugin = {
  version: 1,
  id: 'inspect_note',
  name: '项目说明检查',
  description: '读取README文件并检查文件信息。',
  inputLabel: '说明文件相对路径',
  steps: [
    { tool: 'project_read', arguments: { path: '{{input}}' } },
    { tool: 'project_stat', arguments: { path: '{{step0.path}}' } },
  ],
};
test('registered computer plugins survive restart, execute real scoped tools and stop after disable or grant revocation', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'astral-computer-plugins-')),
    root = join(dir, 'project');
  await mkdir(root);
  await writeFile(join(root, 'README.md'), 'actual-plugin-file');
  const grant = await localGrant(root),
    configPath = join(dir, 'device.json'),
    config = {
      server: 'http://127.0.0.1:1',
      deviceId: randomUUID(),
      token: 'synthetic-only',
      projects: [grant],
    };
  await saveConfig(configPath, config, { create: true });
  const env = {
    ASTRAL_DEVICE_CONFIG: configPath,
    ASTRAL_DEVICE_PROJECT: grant.id,
    ASTRAL_DEVICE_ROOT: grant.root,
    ASTRAL_DEVICE_INO: String(grant.ino),
    ASTRAL_DEVICE_DEV: String(grant.dev),
    ASTRAL_PROJECT_ACCESS: 'read',
    ASTRAL_DEVICE_EXECUTE: '0',
    ASTRAL_PROJECT_ID: 'device',
    ASTRAL_PROJECT_BACKUPS: join(dir, 'backups'),
    ASTRAL_PROJECT_PRIVATE_PATHS: '[]',
    ASTRAL_PROJECTS_FILE: join(dir, 'projects.json'),
  };
  const old = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  t.after(async () => {
    for (const [k, v] of Object.entries(old))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(
    process.env.ASTRAL_PROJECTS_FILE,
    JSON.stringify([
      {
        id: 'device',
        root: grant.root,
        canonicalRoot: grant.root,
        name: grant.name,
        readOnly: true,
      },
    ]),
  );
  const store = createComputerPluginStore(configPath);
  assert.deepEqual(await store.list(grant.id), []);
  const result = await store.apply(grant, {
    kind: 'plugin_register',
    manifest: plugin,
    enabled: true,
    expectedHash: 'new',
  });
  const saved = result.plugins[0];
  assert.deepEqual(await createComputerPluginStore(configPath).list(grant.id), result.plugins);
  const tools = new Map();
  await registerTools({ on() {}, registerTool: (spec) => tools.set(spec.name, spec) });
  const custom = tools.get('custom_inspect_note');
  assert.ok(custom);
  const run = (input) => custom.execute(randomUUID(), { input }, new AbortController().signal);
  const value = JSON.parse((await run('README.md')).content[0].text);
  assert.ok(value.steps[0].result.content.includes('actual-plugin-file'));
  assert.equal(value.steps[1].result.kind, 'file');
  await assert.rejects(() => run('../device.json'), /受保护/);
  const another = await localGrant(root);
  assert.deepEqual(await store.list(another.id), []);
  await assert.rejects(
    () =>
      store.apply(grant, {
        kind: 'plugin_register',
        manifest: plugin,
        enabled: false,
        expectedHash: 'new',
      }),
    /已变化/,
  );
  const disabled = await store.apply(grant, {
    kind: 'plugin_register',
    manifest: plugin,
    enabled: false,
    expectedHash: saved.sha256,
  });
  await assert.rejects(() => run('README.md'), /停用/);
  await store.apply(grant, {
    kind: 'plugin_remove',
    pluginId: plugin.id,
    expectedHash: disabled.plugins[0].sha256,
  });
  assert.deepEqual(await store.list(grant.id), []);
  const shell = {
    ...plugin,
    steps: [{ tool: 'computer_exec', arguments: { command: 'node --version' } }],
  };
  await assert.rejects(
    () =>
      store.apply(grant, {
        kind: 'plugin_register',
        manifest: shell,
        enabled: true,
        expectedHash: 'new',
      }),
    /本机未授权/,
  );
  assert.equal(await readFile(join(root, 'README.md'), 'utf8'), 'actual-plugin-file');
  config.projects = [];
  await saveConfig(configPath, config);
  await assert.rejects(() => run('README.md'), /撤销/);
});
