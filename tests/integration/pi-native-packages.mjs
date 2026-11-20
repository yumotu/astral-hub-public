// Run only in a disposable Pi QA container with the complete copied package tree.
// docker exec -e ASTRAL_QA_ISOLATED=1 -i <qa-pi> node --input-type=module < tests/integration/pi-native-packages.mjs
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { changePackages } from '/bridge/package-transaction.mjs';
import { checkPackageActivation } from '/bridge/package-preflight.mjs';
if (process.env.ASTRAL_QA_ISOLATED !== '1')
  throw new Error(
    'Only run in an isolated QA container with copied packages: ASTRAL_QA_ISOLATED=1',
  );
const root = process.env.ASTRAL_PACKAGES_ROOT || '/home/node/.pi/agent/astral/packages';
process.env.ASTRAL_PACKAGES_ROOT = root;
// This entry point checks the real CLI + atomic transaction without pretending
// to hold an active worker's maintenance token. Exercise the tool/lease path
// separately through a real owner conversation in the isolated app.
const execute = promisify(execFile);
const cli = (action, source, target) => execute('pi', [action, source], {
  env: { PATH: process.env.PATH, HOME: target, PI_CODING_AGENT_DIR: target,
    NO_COLOR: '1', NODE_OPTIONS: '--max-old-space-size=256' },
  timeout: 180000, maxBuffer: 1024 * 1024,
});
const mutate = (action, source) => changePackages(root, {
  mutate: target => cli(action, source, target), validate: checkPackageActivation,
});
const sha = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
const hashes = async () =>
  Object.fromEntries(
    await Promise.all(
      [
        'settings.json',
        'npm/package.json',
        'npm/package-lock.json',
        'npm/node_modules/@diegopetrucci/pi-todo/index.ts',
      ].map(async (name) => [name, await sha(join(root, name))]),
    ),
  );
const base = process.env.ASTRAL_QA_FIXTURE_ROOT || '/projects/workspace/plugin-fixtures';
await mkdir(base, { recursive: true });
for (const [name, body] of [
  [
    'working',
    'pi.registerTool({name:"astral_qa_echo",label:"QA Echo",description:"Echo an acceptance fixture",parameters:{type:"object",properties:{}},async execute(){return{content:[{type:"text",text:"ASTRAL_QA_PLUGIN_OK"}],details:{}}}});',
  ],
  [
    'conflict',
    'pi.registerTool({name:"web_search",label:"Conflict fixture",description:"This must not activate",parameters:{type:"object",properties:{}},async execute(){return{content:[],details:{}}}});',
  ],
]) {
  const dir = join(base, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'astral-qa-' + name,
      version: '1.0.0',
      type: 'module',
      pi: { extensions: ['index.mjs'] },
    }),
  );
  await writeFile(join(dir, 'index.mjs'), 'export default async function(pi){' + body + '}\n');
}
const configured = JSON.parse(await readFile(join(root, 'settings.json'), 'utf8')).packages;
const expectedPackages = Number(process.env.ASTRAL_QA_EXPECTED_PACKAGES);
assert.ok(Number.isInteger(expectedPackages) && expectedPackages > 0,
  'Set ASTRAL_QA_EXPECTED_PACKAGES to the independently counted full copied package list.');
assert.equal(
  configured.length,
  expectedPackages,
  'Copy the complete configured package combination, not an empty package directory.',
);
const proof = {};
const baseline = await checkPackageActivation(root);
assert.ok(baseline.plugins.extensions > 0);
proof.baseline = baseline;
let result = await mutate('install', join(base, 'working'));
proof.validInstall = result;
console.log('VALID_INSTALL_PASS');
assert.equal((await checkPackageActivation(root)).plugins.extensions, baseline.plugins.extensions + 1);
let before = await hashes();
await assert.rejects(
  mutate('install', join(base, 'conflict')),
  (e) => {
    proof.failedInstall = e.message;
    return /web_search/.test(e.message);
  },
);
assert.deepEqual(await hashes(), before);
proof.failedInstallPreservedBytes = true;
console.log('CONFLICT_INSTALL_ROLLBACK_PASS');
await assert.rejects(
  changePackages(root, {
    mutate: async (candidate) => {
      await writeFile(
        join(candidate, 'npm/node_modules/@diegopetrucci/pi-todo/index.ts'),
        'This is not valid JavaScript @@@',
      );
    },
    validate: checkPackageActivation,
  }),
  (e) => {
    proof.failedUpdate = e.message.slice(0, 5000);
    return /extension|插件|Syntax|Unexpected/i.test(e.message);
  },
);
assert.deepEqual(await hashes(), before);
proof.failedUpdatePreservedBytes = true;
console.log('BROKEN_UPDATE_ROLLBACK_PASS');
result = await mutate('remove', join(base, 'working'));
proof.validRemove = result;
console.log('VALID_REMOVE_PASS');
assert.equal((await checkPackageActivation(root)).plugins.extensions, baseline.plugins.extensions);
proof.finalCheck = await checkPackageActivation(root);
assert.equal(proof.finalCheck.plugins.extensions, baseline.plugins.extensions);
proof.finalSources = JSON.parse(await readFile(join(root, 'settings.json'), 'utf8')).packages;
assert.deepEqual(proof.finalSources, configured);
proof.passed = true;
console.log(JSON.stringify(proof));
