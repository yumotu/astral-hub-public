import { readdir, mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { join, basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { expectedReleaseAssets, checksumManifest } from '../shared/release-assets.mjs';
import { macosVerification, requiresMacVerification } from '../shared/macos-verification.mjs';
import { newerVersion } from '../shared/app-updates.mjs';
import { androidVerification, requiresAndroidVerification } from '../shared/android-release-verification.mjs';

export async function prepareRelease({
  root = process.cwd(),
  commit,
  run = process.env.GITHUB_RUN_ID || null,
} = {}) {
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  commit ||= execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const output = join(root, 'release/publish');
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const expected = expectedReleaseAssets(version);
  const collected = [];
  let macReport, androidReport;
  async function collect(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'dist') await collect(path);
      } else if (entry.name === 'macos-verification.json') {
        if (macReport) throw new Error('Duplicate macOS verification report.');
        macReport = JSON.parse(await readFile(path, 'utf8'));
      } else if (entry.name === 'android-verification.json') {
        if (androidReport) throw new Error('Duplicate Android verification report.');
        androidReport = JSON.parse(await readFile(path, 'utf8'));
      } else if (expected.includes(entry.name)) {
        if (collected.some((file) => basename(file) === entry.name))
          throw new Error('Duplicate release asset: ' + entry.name);
        collected.push(path);
        await copyFile(path, join(output, entry.name));
      }
    }
  }
  await collect(join(root, 'artifacts'));
  for (const name of expected)
    if (!collected.some((file) => basename(file) === name))
      throw new Error('Missing release asset: ' + name);
  const hashes = [];
  for (const file of collected.sort())
    hashes.push({
      name: basename(file),
      sha256: createHash('sha256')
        .update(await readFile(file))
        .digest('hex'),
    });
  const modern = requiresMacVerification(version);
  const macos =
    modern || macReport ? macosVerification(macReport, { version, commit, files: hashes }) : null;
  const android = requiresAndroidVerification(version)
    ? androidVerification(androidReport, { version, commit, files: hashes }) : null;
  await writeFile(join(output, 'SHA256SUMS.txt'), checksumManifest(hashes));
  const lf = String.fromCharCode(10);
  await writeFile(
    join(output, 'build-info.json'),
    JSON.stringify(
      {
        version,
        commit,
        run,
        platforms: ['mac-arm64', 'mac-x64', 'win-x64', 'android-debug', 'web'],
        verifiedJobs: [
          'web-and-tests',
          'desktop-macOS',
          'desktop-Windows',
          'android',
          'pi-runtime',
          ...(requiresAndroidVerification(version) ? ['source-audit', 'android-sign'] : []),
          ...(version === '0.8.3' || newerVersion(version, '0.8.3')
            ? ['computer-runtime-linux', 'computer-runtime-macOS', 'computer-runtime-Windows']
            : []),
        ],
        ...(macos ? { macosVerification: macos } : {}),
        ...(android ? { androidVerification: android } : {}),
      },
      null,
      2,
    ) + lf,
  );
  await writeFile(
    join(root, 'release/release-notes.md'),
    [
      ...(['0.8.7', '0.8.8', '0.8.9', '0.8.10', '0.8.11', '0.8.12', '0.8.13'].includes(version)
        ? [await readFile(join(root, `docs/release-${version}.md`), 'utf8')]
        : version === '0.8.5'
          ? [
              '0.8.5 修复安装版电脑聊天图片/文件预览，增加网上插件许愿式安装与邮件直接已读。',
              '电脑聊天保留原始附件快照，图片缩略图/放大、文档预览/下载进入新Android和桌面客户端；旧历史文件无需重复发送。',
              '在电脑项目的插件页描述需求，AI查找真实npm Pi包，预览固定版本、来源、依赖和本机权限，确认后才安装到指定电脑项目。独立副本核对SHA-512并通过实际Pi加载检查，支持停用/启用、移除和恢复上一组合，失败保留原插件。',
              '第三方原生插件使用电脑当前用户的文件/网络权限，需本机执行授权；仅在允许执行命令的任务中加载。安装脚本默认关闭；Bun/uv等依赖及第三方终端UI需要实际适配，加载检查不等于全部运行功能通过。',
              '点开邮件直接标已读；手动已读/未读及Agent对应操作不弹二次确认，正文/位置/草稿保留，未知回执查询原编号、不自动重放。移动/回收站/文件夹和发送仍走原有确认。',
              '已有账号、项目、设备、会话与文件保持。物理Android结果仍待用户确认，新增模拟器测试覆盖真实WebView附件和直接已读交互。',
            ]
          : [
              version + ' 完成电脑项目工作区，改进学习、连续输入、语音与流式输出。',
              '电脑通过主动HTTPS连接访问本机明确授权的项目：文件浏览/预览/下载/编辑和备份、独立原生对话、两条Agent任务并发、单独授权的交互终端。文件权限不隐含执行权限；Shell使用电脑当前用户的系统权限，项目目录不是Shell沙箱。',
              '学习题量自由输入，选择与问答分别设置，总上限默认40且管理员可调；讲解扩充为前置知识、定义推导、完整例题、边界误区和总结，整套出题蓝图与分批生成保留进度、判题及错题复习。',
              '连续补充先进入独立发送条目，立即释放输入框，任务运行时可继续发送；未知送达结果查询原请求编号，不自动重放。支持Android及具备识别服务的网页语音输入，文字先进入可编辑草稿，用户自行发送。',
              '正文首片立即转发，相邻分片短时合并以减少积压；切回对话按当前快照追赶，开始输出正文时正确显示正在回复。',
              '通知支持一键全部已读，邮箱/好友显示未读；项目可修改软件显示名，实际文件夹不变。标签页、PWA、桌面及Android统一品牌图标。任务、对话和电脑文件按账号/目标缓存，并在版本变化时更新。',
              '物理Android仍待用户确认。全平台构建与Android模拟器自动化通过后才发布；实际服务器、真实AI与安装包验收见交接记录。',
            ]),
      (macos?.mode === 'developer-id'
        ? 'macOS 已验证 Developer ID、Apple 公证票据和 Gatekeeper 放行。'
        : 'macOS 使用临时签名；仅验证资源签名完整性，Gatekeeper仍可能拒绝，Apple Developer ID／公证延期。') +
        'Windows 未签名，Android 使用保留的调试签名。实际设备验收以交接记录为准。',
      '源码提交：`' + commit + '`；标签：`v' + version + '`。',
      (process.env.GITHUB_REPOSITORY
        ? '[发行说明](https://github.com/' + process.env.GITHUB_REPOSITORY + '/blob/v' + version + '/docs/release-' + version + '.md)'
        : '发行说明位于当前公开仓库 docs/release-' + version + '.md。'),
    ].join(lf + lf) + lf,
  );
  console.log({ version, commit, assets: collected.map((file) => basename(file)) });
  return { version, commit, files: hashes };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await prepareRelease();
