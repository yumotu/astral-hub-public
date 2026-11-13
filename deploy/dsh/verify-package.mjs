// Run only inside the disposable DSH image with an empty /state and /workspace,
// --network=none and no production mounts or provider credentials.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pnpmEnvironment } from './pnpm-environment.mjs';

if (process.env.ASTRAL_DSH_PACKAGE_QA !== '1') throw Error('Disposable package QA only.');
if (process.env.DEEPSEEK_API_KEY) throw Error('Package QA must not receive a model key.');
const timeout = setTimeout(() => {
  console.error('DSH_PACKAGE_QA_TIMEOUT');
  process.exit(1);
}, 90000);
timeout.unref();
try {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const [key, expected] of [
    ['store-dir', '/state/harness/pnpm-store'],
    ['cache-dir', '/state/harness/pnpm-cache'],
    ['state-dir', '/state/harness/pnpm-state'],
    ['ignore-scripts', 'true'],
  ]) {
    const result = spawnSync(
      process.execPath,
      [join(here, 'node_modules/pnpm/bin/pnpm.mjs'), 'config', 'get', key],
      {
        cwd: '/workspace',
        env: { ...process.env, ...pnpmEnvironment('/state/harness') },
        encoding: 'utf8',
        timeout: 15000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), expected, key);
  }
  const upstream = JSON.parse(await readFile(join(here, 'vendor/UPSTREAM.json'), 'utf8'));
  assert.equal(upstream.commit, '14037e78f45e14f7a5ad56c2266944548def7e3d');
  for (const [name, sha] of Object.entries(upstream.files))
    assert.equal(
      createHash('sha256')
        .update(await readFile(join(here, 'vendor', name)))
        .digest('hex'),
      sha,
    );
  process.env.DSH_SERVER_CONFIG = '/tmp/package-qa-connection.json';
  await writeFile(
    process.env.DSH_SERVER_CONFIG,
    JSON.stringify({
      origin: 'http://127.0.0.1:8971/',
      account: 'synthetic-package-check',
      password: 'synthetic-package-check-'.repeat(3),
      name: 'Disposable package QA',
    }),
    { mode: 0o600, flag: 'wx' },
  );
  await import('./host.mjs');
  const response = await fetch('http://127.0.0.1:8972/health');
  assert.equal(response.status, 200);
  const proof = await response.json();
  assert.equal(proof.ok, true);
  assert.equal(proof.version, '0.8.14');
  assert.equal(proof.revision, 'dsh4');
  assert.equal(proof.fileBridgeVersion, 1);
  assert.equal(proof.workbenchVersion, 1);
  assert.equal(proof.extensionManagerVersion, 1);
  assert.equal(proof.harness, '0.2.2-rc.1');
  assert.equal(proof.remote, upstream.commit);
  assert.equal(proof.workspace, '/workspace');
  const patch = await readFile('/state/harness/profiles/astral-server/cordis.patch.yml', 'utf8');
  assert.match(patch, /astral-app-tools/);
  assert.match(patch, /integrations\/dsh-app-tools\/index\.mjs/);
  const overlay = await readFile('/state/harness/astral-extensions.patch.yml', 'utf8');
  assert.match(overlay, /integrations\/dsh-app-tools\/extensions\.mjs/);
  console.log(
    JSON.stringify({
      check: 'DSH_PACKAGE_QA_PASSED',
      version: proof.version,
      revision: proof.revision,
      fileBridgeVersion: proof.fileBridgeVersion,
      extensionManagerVersion: proof.extensionManagerVersion,
      harness: proof.harness,
      remote: proof.remote,
      modelRequests: 0,
    }),
  );
  clearTimeout(timeout);
  process.kill(process.pid, 'SIGTERM');
} catch (error) {
  console.error('DSH_PACKAGE_QA_FAILED', error.message);
  process.exit(1);
}
