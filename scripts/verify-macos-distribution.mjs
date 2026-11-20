import { spawnSync } from 'node:child_process';
import { readdir, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyMacApps } from './verify-macos.mjs';
import pkg from '../package.json' with { type: 'json' };

function macTool(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  if (result.error || result.status !== 0)
    throw new Error(`${command.split('/').at(-1)} verification failed (${result.status ?? 'process error'}).`);
  return result.stdout + result.stderr;
}
export function assertDeveloperSignature(text, expectedTeam) {
  if (!/^[A-Z0-9]{10}$/.test(expectedTeam || '')) throw new Error('Expected Apple team identifier is required.');
  if (!/^Authority=Developer ID Application: .+$/m.test(text) ||
      !text.split(/\r?\n/).includes('TeamIdentifier=' + expectedTeam) ||
      !/^CodeDirectory[^\r\n]*flags=[^\r\n]*\bruntime\b/m.test(text))
    throw new Error('A hardened Developer ID Application signature from the expected team is required.');
}
export function assertNotarizedAssessment(text) {
  if (!/: accepted(?:\s|$)/m.test(text) || !/^source=Notarized Developer ID\s*$/m.test(text))
    throw new Error('Gatekeeper did not confirm a notarized Developer ID application.');
}
export async function verifyMacBuild(root, { distribution = false, expectedTeam, commit = process.env.GITHUB_SHA || null } = {}) {
  await verifyMacApps(root);
  const apps = [];
  for (const folder of await readdir(root, { withFileTypes: true })) {
    if (!folder.isDirectory() || !folder.name.startsWith('mac')) continue;
    const app = join(root, folder.name, '星屿.app');
    const plist = join(app, 'Contents/Info.plist');
    const executable = macTool('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', plist]).trim();
    const arch = macTool('/usr/bin/lipo', ['-archs', join(app, 'Contents/MacOS', executable)]).trim();
    if (distribution) {
      assertDeveloperSignature(macTool('/usr/bin/codesign', ['--display', '--verbose=4', app]), expectedTeam);
      macTool('/usr/bin/xcrun', ['stapler', 'validate', app]);
      assertNotarizedAssessment(macTool('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', app]));
    }
    apps.push({ arch, integrity: true, notarized: distribution, gatekeeperAccepted: distribution });
  }
  const assets = [];
  for (const arch of ['arm64', 'x64']) for (const extension of ['dmg', 'zip']) {
    const name = `Astral-Hub-${pkg.version}-mac-${arch}.${extension}`, path = join(root, name);
    if (extension === 'dmg') macTool('/usr/bin/hdiutil', ['verify', path]);
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(path)) hash.update(bytes);
    assets.push({ name, bytes: (await stat(path)).size, sha256: hash.digest('hex') });
  }
  const report = { version: pkg.version, commit, mode: distribution ? 'developer-id' : 'integrity-only', apps, assets };
  await writeFile(join(root, 'macos-verification.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  console.log(JSON.stringify(await verifyMacBuild(resolve(process.argv[2] || 'release/desktop'), {
    distribution: process.env.ASTRAL_MACOS_DISTRIBUTION === 'true', expectedTeam: process.env.APPLE_TEAM_ID,
  })));
