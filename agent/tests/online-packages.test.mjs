import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { localGrant, saveConfig } from '../config.mjs';
import {
  createOnlinePackageStore,
  installedPackageRuntime,
  projectPackageRoot,
} from '../online-packages.mjs';
import { leasePackages } from '../package-leases.mjs';
const integrity = 'sha512-' + Buffer.alloc(64, 5).toString('base64');
test('native online packages pass real Pi resource loading, rollback conflicts, obey execution grants and block mutation during tasks', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'astral-online-packages-')),
    project = join(dir, 'project'),
    configPath = join(dir, 'device.json');
  await mkdir(project);
  const grant = await localGrant(project, { allowExecute: true }),
    config = {
      server: 'http://127.0.0.1:1',
      deviceId: randomUUID(),
      token: 'synthetic-only',
      projects: [grant],
    };
  await saveConfig(configPath, config, { create: true });
  t.after(() => rm(dir, { recursive: true, force: true }));
  let conflict = false,
    installed = 0;
  const store = createOnlinePackageStore(configPath, {
    fetch: async () =>
      Response.json({ name: 'synthetic-pi-extension', version: '1.0.0', dist: { integrity } }),
    install: async (root, entries, env) => {
      installed++;
      assert.equal(env.npm_config_ignore_scripts, 'true');
      assert.equal(env.DEEPSEEK_API_KEY, undefined);
      const p = join(root, 'node_modules/synthetic-pi-extension');
      await mkdir(p, { recursive: true });
      await writeFile(
        join(p, 'package.json'),
        JSON.stringify({
          name: 'synthetic-pi-extension',
          version: '1.0.0',
          type: 'module',
          pi: { extensions: ['index.mjs'], skills: ['skills'] },
        }),
      );
      await mkdir(join(p, 'skills/example'), { recursive: true });
      await writeFile(
        join(p, 'skills/example/SKILL.md'),
        '---\nname: fixture_skill\ndescription: Synthetic fixture only\n---\nUse the verified native tool.',
      );
      await writeFile(
        join(p, 'index.mjs'),
        `export default function(pi){pi.registerTool({name:'${conflict ? 'chat_export' : 'fixture_native'}',label:'Fixture',description:'Synthetic native tool',parameters:{type:'object',properties:{},additionalProperties:false},async execute(){return {content:[{type:'text',text:'actual native tool'}]};}});}`,
      );
      await writeFile(
        join(root, 'package-lock.json'),
        JSON.stringify({ packages: { 'node_modules/synthetic-pi-extension': { integrity } } }),
      );
    },
  });
  const op = {
    kind: 'package_install',
    package: { name: 'synthetic-pi-extension', version: '1.0.0', integrity },
    expectedRevision: 'new',
  };
  const first = await store.apply(grant, op);
  assert.equal(first.packages.length, 1);
  assert.deepEqual(first.activation.tools, ['fixture_native']);
  assert.deepEqual(first.activation.skills, ['fixture_skill']);
  const runtime = await installedPackageRuntime(configPath, grant.id, true);
  assert.equal(runtime.roots.length, 1);
  assert.deepEqual(runtime.tools, ['fixture_native']);
  assert.deepEqual((await installedPackageRuntime(configPath, grant.id, false)).roots, []);
  const root = projectPackageRoot(configPath, grant.id),
    original = await readFile(join(root, 'astral-packages.json'), 'utf8');
  conflict = true;
  await assert.rejects(
    () => store.apply(grant, { ...op, expectedRevision: first.revision }),
    /conflict/,
  );
  assert.equal(
    await readFile(join(root, 'astral-packages.json'), 'utf8'),
    original,
    'failed activation must preserve complete active state',
  );
  const release = await leasePackages(configPath, grant.id, 'read');
  await assert.rejects(
    () =>
      store.apply(grant, {
        kind: 'package_enable',
        name: op.package.name,
        enabled: false,
        expectedRevision: first.revision,
      }),
    /任务|变更/,
  );
  await release();
  const disabled = await store.apply(grant, {
    kind: 'package_enable',
    name: op.package.name,
    enabled: false,
    expectedRevision: first.revision,
  });
  assert.deepEqual((await installedPackageRuntime(configPath, grant.id, true)).roots, []);
  const rolled = await store.apply(grant, {
    kind: 'package_rollback',
    expectedRevision: disabled.revision,
  });
  assert.equal(rolled.packages[0].enabled, true);
  assert.deepEqual(rolled.activation.tools, ['fixture_native']);
  grant.allowExecute = false;
  await saveConfig(configPath, config);
  await assert.rejects(
    () =>
      store.apply(grant, {
        kind: 'package_remove',
        name: op.package.name,
        expectedRevision: rolled.revision,
      }),
    /未授权/,
  );
  assert.equal(installed, 2, 'disable/rollback must not redownload packages');
});
