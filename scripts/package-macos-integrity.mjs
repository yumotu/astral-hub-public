import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import desktop from '../desktop/package.json' with { type: 'json' };

// electron-builder skips every signing mode in PRs, including identity "-".
// Only this credential-free, explicitly ad-hoc entry point may opt into that gate.
export function macIntegrityEnvironment(env = process.env, config = desktop.build) {
  const mac = config.mac;
  if (
    env.ASTRAL_MACOS_DISTRIBUTION === 'true' ||
    mac?.identity !== '-' ||
    mac.sign != null ||
    (mac.notarize != null && mac.notarize !== false) ||
    Object.keys(mac).some((key) => /^csc/i.test(key))
  )
    throw Error('The integrity build requires ad-hoc signing without certificate or notarization configuration.');
  const childEnv = Object.fromEntries(
    Object.entries(env).filter(([key]) => !/^(?:CSC_|WIN_CSC_|APPLE_|ASTRAL_APPLE_)/.test(key)),
  );
  childEnv.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  // Do not enable this on a credentialed Developer ID build or for other events.
  if (env.GITHUB_EVENT_NAME === 'pull_request') childEnv.CSC_FOR_PULL_REQUEST = 'true';
  return childEnv;
}

export function packageMacIntegrity({ env = process.env, platform = process.platform, run = spawnSync } = {}) {
  if (platform !== 'darwin') throw Error('A macOS host is required for the integrity build.');
  const childEnv = macIntegrityEnvironment(env);
  const root = fileURLToPath(new URL('../', import.meta.url));
  const project = join(root, 'desktop');
  for (const args of [
    [join(project, 'prepare.cjs')],
    [join(root, 'scripts/prepare-desktop-agent.mjs')],
    [join(project, 'node_modules/electron-builder/cli.js'), '--mac', '--arm64', '--x64', '--publish', 'never', '-c.mac.identity=-', '-c.mac.notarize=false'],
  ]) {
    const result = run(process.execPath, args, { cwd: project, env: childEnv, stdio: 'inherit' });
    if (result.error || result.status !== 0)
      throw Error(`macOS integrity build failed (${result.status ?? 'process error'}).`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  packageMacIntegrity();
