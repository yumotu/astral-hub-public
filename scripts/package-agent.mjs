import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { zipSync } from 'fflate';

export function buildAgent(root = process.cwd(), { web = false } = {}) {
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const manifest = JSON.parse(readFileSync(join(root, 'agent/package.json'), 'utf8'));
  if (manifest.version !== version) throw new Error('远程执行器版本与应用版本不一致。');
  mkdirSync(join(root, 'agent/assets'), { recursive: true });
  const resources = [
    'project-files.mjs',
    'project-lock.mjs',
    'project-tools.mjs',
    'app-tools.mjs',
    'protocol.mjs',
    'file-diff.mjs',
    'rpc-prompt.mjs',
    'activity-deadline.mjs',
    'ask-user.mjs',
    'long-goal.mjs',
    'long-goal-command.mjs',
    ...['index.ts', 'goal-state.ts', 'usage.ts', 'LICENSE', 'UPSTREAM.json'].map(
      (name) => 'vendor/pi-goal/' + name,
    ),
    'stream-writer.mjs',
    'package-transaction.mjs',
    'document-text.mjs',
    'attachments.mjs',
    'pdf-content.mjs',
    'pdf-document.mjs',
    'chat-content.mjs',
    'office-content.mjs',
    'attachment-limits.mjs',
  ];
  for (const file of resources) {
    mkdirSync(dirname(join(root, 'agent/assets', file)), { recursive: true });
    cpSync(join(root, 'deploy/pi', file), join(root, 'agent/assets', file));
  }
  cpSync(join(root, 'shared/computer-plugin.mjs'), join(root, 'agent/assets/computer-plugin.mjs'));
  cpSync(
    join(root, 'shared/computer-package.mjs'),
    join(root, 'agent/assets/computer-package.mjs'),
  );
  const lf = String.fromCharCode(10);
  writeFileSync(
    join(root, 'agent/README.txt'),
    [
      '星屿远程 Pi 执行器 ' + version,
      '需要 Node.js 24 或更新版本，支持 macOS 和 Windows。',
      '1. 在此目录运行 npm install --ignore-scripts',
      '2. 在网页 智能助手 / 电脑连接 生成配对码',
      '3. node relay-agent.mjs --server https://你的服务器 --pair-code 配对码 --root 本机项目目录',
      '默认只读。允许修改时增加 --allow-write。设备凭据保存在 ~/.astral-agent/device.json，请勿分享。',
      '添加项目：node relay-agent.mjs --add-project "本机项目目录" [--label "显示名"] [--allow-write] [--allow-execute]',
      '项目授权仅在本机修改：node relay-agent.mjs --project 项目编号 --read-only；删除授权：--revoke-project 项目编号。',
      '若需终端，先在执行器目录运行 npm run terminal:setup；它只准备已固定版本的node-pty，不开启任何项目权限。',
      '--allow-execute 单独允许终端和Agent命令，使用当前本机用户的完整系统权限，项目目录不是Shell沙箱；只读文件权限不限制已经明确授权的Shell。',
      '每个电脑项目有独立会话，可同时执行2个对话；补充可立即送入当前任务。旧版共享会话记录仍保留。',
      '主对话可通过app_functions使用当前账号的联系人、邮箱、学习等软件功能；发送在聊天预览后确认，不扩大本机文件和命令权限。',
      '断线后只补回状态与终端输出，未知结果的任务、写入或按键不自动重发；本机目录变化、授权撤销、取消或退出会停止受控任务。',
      '使用 http://127.0.0.1:8789 时，必须是目标电脑自己的 SSH 隧道。',
      '按 Ctrl+C 停止，或在软件中撤销授权。',
    ].join(lf) + lf,
  );
  const names = [
    'relay-agent.mjs',
    'workspace.mjs',
    'config.mjs',
    'task-runner.mjs',
    'task-worker.mjs',
    'project-adapter.mjs',
    'file-tools.mjs',
    'extra-tools.mjs',
    'computer-tools.mjs',
    'input-tools.mjs',
    'plugin-store.mjs',
    'online-packages.mjs',
    'package-leases.mjs',
    'package-probe.mjs',
    'package-read.mjs',
    'execute-tools.mjs',
    'process-tree.mjs',
    'terminal-runtime.mjs',
    'windows-pty.mjs',
    'terminal-worker.mjs',
    'prepare-terminal.mjs',
    'package.json',
    'README.txt',
    ...resources.map((name) => 'assets/' + name),
    'assets/computer-plugin.mjs',
    'assets/computer-package.mjs',
  ];
  if (existsSync(join(root, 'agent/package-lock.json'))) names.push('package-lock.json');
  const files = Object.fromEntries(
    names
      .sort()
      .map((name) => [
        'astral-remote-pi-agent/' + name,
        new TextEncoder().encode(
          readFileSync(join(root, 'agent', name), 'utf8').replace(
            /\r\n?/g,
            String.fromCharCode(10),
          ),
        ),
      ]),
  );
  const bytes = zipSync(files, { level: 9, mtime: new Date(2020, 0, 1) });
  const name = 'Astral-Remote-Pi-Agent-' + version + '.zip';
  mkdirSync(join(root, 'release'), { recursive: true });
  writeFileSync(join(root, 'release', name), bytes);
  if (web) {
    mkdirSync(join(root, 'web/public/downloads'), { recursive: true });
    writeFileSync(join(root, 'web/public/downloads', name), bytes);
  }
  console.log('release/' + name);
  return { version, name, bytes };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  buildAgent(process.cwd(), { web: process.argv.includes('--web') });
