import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { macIntegrityEnvironment, packageMacIntegrity } from '../scripts/package-macos-integrity.mjs';
import desktop from '../desktop/package.json' with { type: 'json' };

test('PR integrity signing opts in only with explicit ad-hoc configuration and no signing credentials', () => {
  const env = {
    GITHUB_EVENT_NAME: 'pull_request', GITHUB_BASE_REF: 'main', PATH: '/synthetic/bin',
    CSC_LINK: 'synthetic-certificate', CSC_KEY_PASSWORD: 'synthetic-password',
    CSC_NAME: 'Developer ID Application: Synthetic', CSC_KEYCHAIN: '/synthetic/keychain',
    WIN_CSC_LINK: 'synthetic-windows-certificate', APPLE_API_KEY: '/synthetic/key.p8',
    APPLE_API_ISSUER: 'synthetic-issuer', ASTRAL_APPLE_API_KEY_BASE64: 'synthetic-private-key',
  };
  const original = { ...env };
  const result = macIntegrityEnvironment(env);
  assert.deepEqual(env, original);
  assert.deepEqual(result, {
    GITHUB_EVENT_NAME: 'pull_request', GITHUB_BASE_REF: 'main', PATH: '/synthetic/bin',
    CSC_IDENTITY_AUTO_DISCOVERY: 'false', CSC_FOR_PULL_REQUEST: 'true',
  });
  for (const event of ['push', 'workflow_dispatch', 'pull_request_target', undefined]) {
    const clean = macIntegrityEnvironment({ GITHUB_EVENT_NAME: event, CSC_FOR_PULL_REQUEST: 'true' });
    assert.equal(clean.CSC_FOR_PULL_REQUEST, undefined);
  }
  for (const mac of [
    { ...desktop.build.mac, identity: undefined },
    { ...desktop.build.mac, identity: 'Developer ID Application: Synthetic' },
    { ...desktop.build.mac, sign: './custom-signer.cjs' },
    { ...desktop.build.mac, notarize: true },
    { ...desktop.build.mac, cscLink: 'synthetic-certificate' },
  ]) assert.throws(() => macIntegrityEnvironment(env, { ...desktop.build, mac }), /ad-hoc signing/);
  assert.throws(() => macIntegrityEnvironment({ ASTRAL_MACOS_DISTRIBUTION: 'true' }), /ad-hoc signing/);
});

test('integrity packaging signs both architectures before archives and never invokes publication', () => {
  const calls = [];
  packageMacIntegrity({ platform: 'darwin', env: { GITHUB_EVENT_NAME: 'pull_request', CSC_LINK: 'secret' },
    run(program, args, options) { calls.push({ program, args, options }); return { status: 0 }; },
  });
  assert.equal(calls.length, 3);
  assert.match(calls[0].args[0], /(?:^|[\\/])desktop[\\/]prepare\.cjs$/);
  assert.match(calls[1].args[0], /(?:^|[\\/])scripts[\\/]prepare-desktop-agent\.mjs$/);
  assert.match(calls[2].args[0], /(?:^|[\\/])desktop[\\/]node_modules[\\/]electron-builder[\\/]cli\.js$/);
  assert.deepEqual(calls[2].args.slice(1), [
    '--mac', '--arm64', '--x64', '--publish', 'never', '-c.mac.identity=-', '-c.mac.notarize=false',
  ]);
  assert.ok(calls.every(({ options }) => options.env.CSC_LINK === undefined && options.env.CSC_FOR_PULL_REQUEST === 'true'));
  let count = 0;
  assert.throws(() => packageMacIntegrity({ platform: 'darwin', env: {}, run() { count++; return { status: 7 }; } }), /failed \(7\)/);
  assert.equal(count, 1);
  assert.throws(() => packageMacIntegrity({ platform: 'linux', run() { assert.fail('must not build'); } }), /macOS host/);
});

test('public Mac CI retains strict verification and never receives protected signing secrets', () => {
  const workflow = readFileSync(new URL('../.github/workflows/packages.yml', import.meta.url), 'utf8');
  const job = workflow.slice(workflow.indexOf('\n  desktop:'), workflow.indexOf('\n  android:'));
  const packageIndex = job.indexOf('node scripts/package-macos-integrity.mjs');
  const verificationIndex = job.indexOf('node scripts/verify-macos-distribution.mjs release/desktop');
  assert.ok(packageIndex >= 0 && verificationIndex > packageIndex);
  assert.ok(job.indexOf('actions/upload-artifact@v4') > verificationIndex);
  assert.doesNotMatch(job, /secrets\.|contents:\s*write|continue-on-error|CSC_FOR_PULL_REQUEST/);
  assert.match(job, /ASTRAL_MACOS_DISTRIBUTION: 'false'/);
});
