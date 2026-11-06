import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signAndroid, signerEvidence } from '../scripts/sign-android-release.mjs';
import { androidVerification, requiresAndroidVerification } from '../shared/android-release-verification.mjs';
const fingerprint = 'a'.repeat(64), commit = 'c'.repeat(40);
const settings = () => ({ APKSIGNER: 'test-apksigner', ANDROID_KEYSTORE_BASE64: Buffer.alloc(32, 65).toString('base64'), ANDROID_STORE_PASSWORD: 'synthetic-store-password', ANDROID_KEY_PASSWORD: 'synthetic-key-password', ANDROID_KEY_ALIAS: 'synthetic-key', ANDROID_CERT_SHA256: fingerprint });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'astral-signing-qa-')); t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, 'input.apk'), output = join(root, 'output.apk'); await writeFile(input, 'unsigned synthetic APK');
  return { root, input, output, temporaryRoot: root, version: '0.8.9', commit, certificateSha256: fingerprint, env: settings() };
}
test('release signing isolates key material, pins certificate and binds the resulting APK to the source', async t => {
  const f = await fixture(t), calls = [];
  // execFileSync is synchronous; the stand-in writes output before returning.
  const { readFileSync, writeFileSync, statSync } = await import('node:fs');
  const report = await signAndroid({ ...f, run: (bin, args, opts) => { calls.push({ bin, args, opts }); assert.equal(opts.env.ANDROID_KEYSTORE_BASE64, undefined); assert.ok(!args.includes(f.env.ANDROID_STORE_PASSWORD));
    if (args[0] === 'sign') { const path = args[args.indexOf('--ks') + 1]; assert.deepEqual(readFileSync(path), Buffer.alloc(32, 65)); if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600); writeFileSync(f.output, 'signed synthetic APK'); return ''; }
    return 'Verified using v2 scheme (APK Signature Scheme v2): true\nSigner #1 certificate SHA-256 digest: ' + fingerprint + '\n';
  } });
  assert.equal(report.certificateSha256, fingerprint); assert.equal(calls.length, 2); assert.equal(report.commit, commit);
  assert.deepEqual(JSON.parse(await readFile(join(f.root, 'android-verification.json'), 'utf8')), report);
  assert.deepEqual((await readdir(f.root)).sort(), ['android-verification.json', 'input.apk', 'output.apk']);
  assert.ok(androidVerification(report, { version: f.version, commit, files: [{ name: 'Astral-Hub-0.8.9-android-debug.apk', sha256: report.apkSha256 }] }).integrity);
  assert.throws(() => androidVerification(report, { version: f.version, commit: 'd'.repeat(40), files: [] }), /provenance/);
});
test('wrong certificate or signer failure leaves no publishable output and never echoes secrets', async t => {
  const f = await fixture(t), { writeFileSync } = await import('node:fs');
  for (const failure of ['mismatch', 'tool']) {
    await assert.rejects(signAndroid({ ...f, run: (_bin, args) => { if (args[0] === 'sign') { writeFileSync(f.output, 'partial output'); return ''; } if (failure === 'tool') throw Error(f.env.ANDROID_STORE_PASSWORD); return 'Verified using v2 scheme: true\nSigner #1 certificate SHA-256 digest: ' + 'b'.repeat(64); } }), e => e.message.includes('signing failed') && !e.message.includes(f.env.ANDROID_STORE_PASSWORD));
    assert.deepEqual(await readdir(f.root), ['input.apk']);
  }
});
test('release signing requires existing key configuration and rejects incomplete or multiple signers', async t => {
  const f = await fixture(t); delete f.env.ANDROID_KEYSTORE_BASE64;
  await assert.rejects(signAndroid(f), /ANDROID_KEYSTORE_BASE64/);
  assert.throws(() => signerEvidence('Signer #1 certificate SHA-256 digest: ' + fingerprint), /incomplete/);
  assert.throws(() => signerEvidence('Verified using v2 scheme: true\nSigner #1 certificate SHA-256 digest: ' + fingerprint + '\nSigner #2 certificate SHA-256 digest: ' + fingerprint), /incomplete/);
  assert.equal(requiresAndroidVerification('0.8.8'), false); assert.equal(requiresAndroidVerification('0.8.9'), true); assert.equal(requiresAndroidVerification('1.0.0'), true);
});
