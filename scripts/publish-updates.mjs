import { readFile, mkdir, copyFile, rename, writeFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { updateManifestSchema, newerVersion } from '../shared/app-updates.mjs';
import { trustedMacDistribution } from '../shared/macos-verification.mjs';
import { androidVerification, requiresAndroidVerification } from '../shared/android-release-verification.mjs';
export async function publishUpdates(from, to) {
  const info = JSON.parse(await readFile(join(from, 'build-info.json'), 'utf8'));
  const modern = info.version === '0.8.0' || newerVersion(info.version, '0.8.0');
  const signedMac = trustedMacDistribution(info.macosVerification);
  const requiredJobs = [
    'web-and-tests',
    'desktop-macOS',
    'desktop-Windows',
    'android',
    ...(modern ? ['pi-runtime'] : []),
    ...(requiresAndroidVerification(info.version) ? ['source-audit', 'android-sign'] : []),
    ...(info.version === '0.8.3' || newerVersion(info.version, '0.8.3')
      ? ['computer-runtime-linux', 'computer-runtime-macOS', 'computer-runtime-Windows']
      : []),
  ];
  if (!requiredJobs.every((j) => info.verifiedJobs?.includes(j)))
    throw new Error('仅发布通过全部原生 CI 的安装包。');
  const sums = new Map(
    (await readFile(join(from, 'SHA256SUMS.txt'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => {
        const [sha256, name] = line.split(/\s+/);
        return [name, sha256];
      }),
  );
  const assets = [];
  for (const [platform, suffix] of Object.entries({
    'mac-arm64': 'mac-arm64.dmg',
    'mac-x64': 'mac-x64.dmg',
    'win-x64': 'win-x64.exe',
    android: 'android-debug.apk',
  })) {
    const name = `Astral-Hub-${info.version}-${suffix}`,
      path = join(from, name);
    const bytes = (await stat(path)).size;
    const sha256 = createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
    if (sums.get(name) !== sha256) throw new Error('安装包校验失败：' + name);
    assets.push({ name, platform, bytes, sha256 });
  }
  if (requiresAndroidVerification(info.version))
    androidVerification(info.androidVerification, { version: info.version, commit: info.commit, files: assets });
  const manifest = updateManifestSchema.parse({
    version: info.version,
    commit: info.commit,
    generatedAt: new Date().toISOString(),
    notes: modern
      ? '已通过网页、macOS、Windows、Android 原生构建和 Pi 容器检查；' +
        (signedMac
          ? 'macOS 已验证 Developer ID、公证票据和 Gatekeeper，'
          : 'macOS 未确认 Apple 正式签名／公证，') +
        'Android 使用调试签名。'
      : '已通过网页、macOS、Windows、Android 原生构建；桌面未签名，Android 使用调试签名。',
    assets,
  });
  const dir = join(to, manifest.version);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const a of assets) {
    const temp = join(dir, a.name + '.next');
    await copyFile(join(from, a.name), temp);
    await rename(temp, join(dir, a.name));
  }
  await writeFile(join(to, 'manifest.next.json'), JSON.stringify(manifest, null, 2), {
    mode: 0o600,
  });
  await rename(join(to, 'manifest.next.json'), join(to, 'manifest.json'));
  return manifest;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2] || !process.argv[3])
    throw new Error(
      '用法: node scripts/publish-updates.mjs <已验收 Release 文件目录> <更新服务目录>',
    );
  const result = await publishUpdates(resolve(process.argv[2]), resolve(process.argv[3]));
  console.log({ version: result.version, platforms: result.assets.map((a) => a.platform) });
}
