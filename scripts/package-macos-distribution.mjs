import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import signing from '../desktop/macos-signing.cjs';

export async function packageMacDistribution({
  env = process.env,
  platform = process.platform,
  temporaryRoot = tmpdir(),
  run = spawnSync,
} = {}) {
  if (platform !== 'darwin') throw new Error('A macOS host is required for Developer ID builds.');
  // Check identifiers/credential presence before creating files or starting the build.
  const childEnv = { ...env, APPLE_API_KEY: env.ASTRAL_APPLE_API_KEY_BASE64 ? 'prepared-private-key' : '', CSC_IDENTITY_AUTO_DISCOVERY: 'true' };
  delete childEnv.ASTRAL_APPLE_API_KEY_BASE64;
  signing.requireMacSigning(childEnv);
  const key = signing.decodeNotaryKey(env.ASTRAL_APPLE_API_KEY_BASE64);
  let directory;
  const desktop = fileURLToPath(new URL('../desktop/', import.meta.url));
  try {
    directory = await mkdtemp(join(temporaryRoot, 'astral-apple-signing-'));
    await chmod(directory, 0o700);
    const path = join(directory, `AuthKey_${env.APPLE_API_KEY_ID}.p8`);
    await writeFile(path, key, { mode: 0o600 });
    childEnv.APPLE_API_KEY = path;
    for (const args of [
      [join(desktop, 'prepare.cjs')],
      [join(desktop, 'node_modules/electron-builder/cli.js'), '--config', 'macos-distribution.cjs', '--mac', '--arm64', '--x64', '--publish', 'never'],
    ]) {
      const result = run(process.execPath, args, { cwd: desktop, env: childEnv, stdio: 'inherit' });
      if (result.error || result.status !== 0)
        throw new Error(`macOS distribution build failed (${result.status ?? 'process error'}).`);
    }
  } finally {
    key.fill(0);
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await packageMacDistribution();
