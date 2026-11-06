import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function signerEvidence(text) {
  const certificates = [...text.matchAll(/^Signer #\d+ certificate SHA-256 digest:\s*([a-fA-F0-9:]+)\s*$/gm)];
  const schemes = [...text.matchAll(/Verified using (v\d(?:\.\d)?) scheme[^:\r\n]*:\s*true/g)].map(m => m[1]);
  if (certificates.length !== 1 || !schemes.length) throw Error('Android signature evidence is incomplete.');
  const certificateSha256 = certificates[0][1].replaceAll(':', '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(certificateSha256)) throw Error('Invalid Android signer fingerprint.');
  return { certificateSha256, schemes };
}

export async function signAndroid({ input, output, version, commit, certificateSha256, env = process.env, run = execFileSync, temporaryRoot = tmpdir() }) {
  for (const name of ['ANDROID_KEYSTORE_BASE64', 'ANDROID_STORE_PASSWORD', 'ANDROID_KEY_PASSWORD', 'ANDROID_KEY_ALIAS'])
    if (!env[name]) throw Error('Required Android signing secret is missing: ' + name);
  if (!/^\d+\.\d+\.\d+$/.test(version || '') || !/^[a-f0-9]{40}$/.test(commit || '')) throw Error('Android release provenance is required.');
  const expected = (certificateSha256 || '').replaceAll(':', '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expected)) throw Error('ANDROID_CERT_SHA256 must pin the existing application certificate.');
  if (env.ANDROID_CERT_SHA256 && env.ANDROID_CERT_SHA256.replaceAll(':', '').toLowerCase() !== expected) throw Error('Configured certificate differs from the reviewed application certificate.');
  const encoded = env.ANDROID_KEYSTORE_BASE64.replace(/\s/g, ''), key = Buffer.from(encoded, 'base64');
  if (key.length < 16 || key.length > 4 * 1024 * 1024 || key.toString('base64') !== encoded) throw Error('Invalid protected Android keystore encoding.');
  const signer = env.APKSIGNER || join(env.ANDROID_HOME || '', 'build-tools/35.0.0/apksigner');
  if (!env.APKSIGNER && !env.ANDROID_HOME) throw Error('Android build tools are required.');
  const source = await readFile(input), directory = await mkdtemp(join(temporaryRoot, 'astral-android-release-'));
  const keyPath = join(directory, 'signing.keystore'), reportPath = join(resolve(output, '..'), 'android-verification.json');
  const childEnv = { ...env }; delete childEnv.ANDROID_KEYSTORE_BASE64;
  try {
    await writeFile(keyPath, key, { mode: 0o600 });
    await mkdir(resolve(output, '..'), { recursive: true });
    run(signer, ['sign', '--ks', keyPath, '--ks-key-alias', env.ANDROID_KEY_ALIAS, '--ks-pass', 'env:ANDROID_STORE_PASSWORD', '--key-pass', 'env:ANDROID_KEY_PASSWORD', '--out', output, input], { env: childEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const evidence = signerEvidence(run(signer, ['verify', '--verbose', '--print-certs', output], { env: childEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    if (evidence.certificateSha256 !== expected) throw Error('Certificate continuity check failed.');
    const bytes = await readFile(output); if (!bytes.length) throw Error('Signed APK is empty.');
    const report = { version, commit, integrity: true, ...evidence, inputSha256: createHash('sha256').update(source).digest('hex'), apkSha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    return report;
  } catch {
    await rm(output, { force: true }); await rm(reportPath, { force: true });
    throw Error('Android release signing failed; check protected signing configuration and the pinned certificate.');
  } finally {
    key.fill(0); await rm(directory, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { version } = JSON.parse(await readFile('package.json', 'utf8'));
  const certificateSha256 = (await readFile('android/signing-certificate.sha256', 'utf8')).trim();
  const report = await signAndroid({ input: resolve(process.argv[2] || 'signing-input', `Astral-Hub-${version}-android-tested.apk`), output: resolve('release', `Astral-Hub-${version}-android-debug.apk`), version, commit: process.env.GITHUB_SHA, certificateSha256 });
  console.log(JSON.stringify({ version, commit: report.commit, certificateSha256: report.certificateSha256, apkSha256: report.apkSha256 }));
}
