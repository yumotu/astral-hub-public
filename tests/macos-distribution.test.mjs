import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { statSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import signing from '../desktop/macos-signing.cjs';
import { packageMacDistribution } from '../scripts/package-macos-distribution.mjs';
import { assertDeveloperSignature, assertNotarizedAssessment } from '../scripts/verify-macos-distribution.mjs';
import { macosVerification, requiresMacVerification, trustedMacDistribution } from '../shared/macos-verification.mjs';
import desktop from '../desktop/package.json' with { type: 'json' };

const credentials = () => ({
  CSC_LINK: 'synthetic-certificate', CSC_KEY_PASSWORD: 'synthetic-password',
  APPLE_API_KEY: '/synthetic/key.p8', APPLE_API_KEY_ID: 'KEYID12345',
  APPLE_API_ISSUER: '12345678-1234-1234-1234-123456789abc', APPLE_TEAM_ID: 'TEAMID1234',
});

test('distribution configuration fails closed without credentials, preserves the ordinary package and does not log secrets', () => {
  const env = credentials();
  delete env.APPLE_TEAM_ID;
  assert.throws(() => signing.macDistributionConfig(desktop.build, env), error =>
    /APPLE_TEAM_ID/.test(error.message) && !/synthetic-password|synthetic-certificate/.test(error.message));
  const base = structuredClone(desktop.build), config = signing.macDistributionConfig(base, credentials());
  assert.equal(base.mac.identity, '-');
  assert.equal(config.mac.identity, undefined);
  assert.equal(config.forceCodeSigning, true);
  assert.equal(config.mac.notarize, true);
  assert.equal(config.mac.hardenedRuntime, true);
  assert.equal(config.dmg.sign, true);
  assert.deepEqual(config.files, base.files);
  for (const extra of [{ CSC_NAME: '-' }, { CSC_IDENTITY_AUTO_DISCOVERY: 'false' }, { APPLE_ID: 'synthetic@example.invalid' }])
    assert.throws(() => signing.macDistributionConfig(base, { ...credentials(), ...extra }));
});

test('private notarization keys are validated, kept at 0600 outside the artifact tree and removed on build failure', async t => {
  const root = await mkdtemp(join(tmpdir(), 'astral-signing-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const encoded = Buffer.from(pem).toString('base64');
  assert.equal(signing.decodeNotaryKey(encoded).toString(), pem);
  for (const value of ['', '%not-base64%', Buffer.from('not a private key').toString('base64')])
    assert.throws(() => signing.decodeNotaryKey(value), e => !e.message.includes(value || '__none__'));
  let keyPath, calls = 0;
  const env = { ...credentials(), ASTRAL_APPLE_API_KEY_BASE64: encoded };
  await assert.rejects(packageMacDistribution({ env, platform: 'darwin', temporaryRoot: root, run(_program, args, options) {
    calls++;keyPath = options.env.APPLE_API_KEY;
    assert.ok(keyPath.startsWith(root + '/astral-apple-signing-'));
    assert.equal(statSync(keyPath).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(keyPath)).mode & 0o777, 0o700);
    assert.equal(readFileSync(keyPath, 'utf8'), pem);
    assert.equal(options.env.ASTRAL_APPLE_API_KEY_BASE64, undefined);
    assert.ok(args.every(value => !value.includes(encoded) && !value.includes('synthetic-password')));
    return { status: 23 };
  } }), /build failed \(23\)/);
  assert.equal(calls, 1);
  await assert.rejects(stat(keyPath), { code: 'ENOENT' });
  assert.deepEqual(await readdir(root), []);
  await assert.rejects(packageMacDistribution({ env, platform: 'linux', run() { assert.fail('must not start a build'); } }), /macOS host/);
});

test('Developer ID, the expected team and hardened runtime are all required; an accepted disabled policy is insufficient', () => {
  const details = 'CodeDirectory v=20500 flags=0x10000(runtime)\nAuthority=Developer ID Application: Synthetic (TEAMID1234)\nTeamIdentifier=TEAMID1234\n';
  assert.doesNotThrow(() => assertDeveloperSignature(details, 'TEAMID1234'));
  for (const text of [details.replace('TEAMID1234\n', 'OTHERID123\n'), details.replace('Developer ID Application', 'Apple Development'), details.replace('0x10000(runtime)', '0x2(adhoc)')])
    assert.throws(() => assertDeveloperSignature(text, 'TEAMID1234'));
  assert.doesNotThrow(() => assertNotarizedAssessment('/Synthetic.app: accepted\nsource=Notarized Developer ID\n'));
  for (const text of ['/Synthetic.app: accepted\nsource=Developer ID\n', 'assessments disabled\n', '/Synthetic.app: rejected\nsource=Notarized Developer ID\n'])
    assert.throws(() => assertNotarizedAssessment(text));
});

function reportFixture(signed = false) {
  const version = '0.8.0', commit = 'a'.repeat(40);
  const files = ['arm64', 'x64'].flatMap(arch => ['dmg', 'zip'].map(ext => ({ name: `Astral-Hub-${version}-mac-${arch}.${ext}`, sha256: 'b'.repeat(64) })));
  const report = { version, commit, mode: signed ? 'developer-id' : 'integrity-only',
    apps: ['arm64', 'x86_64'].map(arch => ({ arch, integrity: true, notarized: signed, gatekeeperAccepted: signed })), assets: structuredClone(files) };
  return { report, context: { version, commit, files } };
}

test('macOS provenance binds the two architectures and every installer hash to this release commit', () => {
  assert.equal(requiresMacVerification('0.7.34'), false);
  assert.equal(requiresMacVerification('0.8.0'), true);
  assert.equal(requiresMacVerification('1.0.0'), true);
  for (const signed of [false, true]) {
    const { report, context } = reportFixture(signed);
    assert.equal(trustedMacDistribution(macosVerification(report, context)), signed);
    for (const change of [r => { r.commit = 'c'.repeat(40); }, r => { r.apps[1].arch = 'arm64'; }, r => { r.assets[0].sha256 = 'c'.repeat(64); }, r => { r.apps[0].gatekeeperAccepted = !signed; }]) {
      const bad = structuredClone(report);change(bad);assert.throws(() => macosVerification(bad, context));
    }
  }
  assert.equal(trustedMacDistribution(undefined), false);
  assert.throws(() => trustedMacDistribution({ mode: 'developer-id', integrity: true }));
});
