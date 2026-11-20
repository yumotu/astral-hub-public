import { Type } from 'typebox';
import { spawn } from 'node:child_process';
import { realpath, readFile } from 'node:fs/promises';
import { relative, isAbsolute } from 'node:path';
import { redact } from './project-files.mjs';
import { changePackages } from './package-transaction.mjs';
import { checkPackageActivation, saveActivation } from './package-preflight.mjs';
import { cleanDiagnostic } from './runtime-diagnostics.mjs';

export default function (pi) {
  if (process.env.ASTRAL_SKILLS_WRITE !== '1') return;
  pi.registerTool({
    name: 'package_manage',
    label: '管理 Pi 插件',
    description:
      '使用 Pi 官方包管理器列出、安装、更新或移除原生 Pi 包，check 检查完整插件组合。只有用户明确要求变更时才变更。安装/更新先在副本完成真实 Pi 启动检查，失败不替换当前插件，成功从下一轮加载。取消、中断、超时或 No result provided 代表变更结果尚未确认，不能据此断言已安装或未安装；先 list/check 核验，不直接重放安装。安装成功与运行依赖就绪分别报告。来源支持 npm:、git:、https:// 或项目内绝对路径。不得虚构安装或启用结果。原生扩展拥有 Pi 进程的文件和环境变量权限。',
    parameters: Type.Object(
      {
        action: Type.Union(
          ['list', 'check', 'install', 'remove', 'update'].map((x) => Type.Literal(x)),
        ),
        source: Type.Optional(Type.String({ maxLength: 500 })),
      },
      { additionalProperties: false },
    ),
    async execute(_id, { action, source }, signal, onUpdate) {
      const changes = ['install', 'remove', 'update'].includes(action);
      if (changes && (!source || source.startsWith('-') || /[\x00-\x20\x7f]/.test(source)))
        throw new Error('请提供有效的 Pi 包来源。');
      if (source && changes) {
        if (isAbsolute(source)) {
          const path = await realpath(source);
          const root = await realpath('/projects');
          const rel = relative(root, path);
          if (!rel || rel.startsWith('..') || isAbsolute(rel))
            throw new Error('本地插件必须位于项目目录中。');
          source = path;
        } else if (
          !/^(npm:|git:|https:\/\/)/.test(source) ||
          /["'`;$|<>\\]/.test(source) ||
          /:\/\/[^/]*@/.test(source)
        ) {
          throw new Error('仅支持 npm:、git:、HTTPS 或项目内本地路径。');
        }
      }
      let output = '';
      const progress = (text) => {
        output = (output + cleanDiagnostic(text)).slice(-20000);
        onUpdate?.({ content: [{ type: 'text', text: output }], details: {} });
      };
      const root = process.env.ASTRAL_PACKAGES_ROOT;
      const run = async (target) => {
        const env = { ...process.env, HOME: target, PI_CODING_AGENT_DIR: target };
        delete env.PI_OFFLINE;
        for (const key of Object.keys(env))
          if (/(?:KEY|TOKEN|PASSWORD|SECRET)$/.test(key)) delete env[key];
        const result = await new Promise((resolve, reject) => {
          const child = spawn('pi', [action, ...(action === 'list' ? [] : [source])], {
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let expired = false,
            force;
          const stop = () => {
            child.kill('SIGTERM');
            force = setTimeout(() => child.kill('SIGKILL'), 3000);
          };
          const timeout = setTimeout(() => {
            expired = true;
            stop();
          }, 180000);
          const abort = stop;
          signal?.addEventListener('abort', abort, { once: true });
          const append = (buf) => {
            progress(buf.toString());
          };
          child.stdout.on('data', append);
          child.stderr.on('data', append);
          child.on('error', reject);
          child.on('close', (code) => {
            clearTimeout(timeout);
            clearTimeout(force);
            signal?.removeEventListener('abort', abort);
            resolve({ code, expired });
          });
        });
        if (result.code !== 0)
          throw new Error(
            `Pi 包管理失败${result.expired ? '（超时）' : ''}：${output.slice(-4000)}`,
          );
      };
      const lease = async (acquire) => {
        const endpoint = process.env.ASTRAL_PLUGIN_ENDPOINT?.replace(/\/cron$/, '/package-lease');
        if (!endpoint || !process.env.ASTRAL_PLUGIN_TOKEN)
          throw new Error('插件变更需要新版星屿执行通道。');
        const r = await fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + process.env.ASTRAL_PLUGIN_TOKEN,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ acquire }),
          signal: AbortSignal.timeout(10000),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || '插件维护锁不可用。');
      };
      if (changes) await lease(true);
      try {
        let checked;
        if (action === 'list') {
          await run(root);
          try {
            const state = JSON.parse(await readFile(root + '.activation.json', 'utf8'));
            progress(`\n最近启用检查：${state.ready ? '通过' : '失败'} · ${state.checkedAt || ''}`);
          } catch (e) {
            if (e.code !== 'ENOENT') throw e;
          }
        } else {
          try {
            const validate = (target) =>
              checkPackageActivation(target, { signal, onUpdate: progress });
            checked = changes
              ? await changePackages(root, {
                  mutate: run,
                  validate,
                  signal,
                  onStage: (s) => progress('\n' + s + '\n'),
                })
              : await validate(root);
          } catch (e) {
            throw new Error(
              cleanDiagnostic(e.message) +
                (changes ? '\n未启用此次变更，原插件配置和依赖文件保持不变。' : ''),
            );
          }
          await saveActivation(root, { ...checked, action });
          progress(`\n完整插件组合启动检查通过：${checked.plugins.extensions} 个扩展入口。`);
          if (changes)
            progress('\n变更已启用，将在下一轮加载；已保留完整上一版本。后台插件仍需星屿适配。');
          if (checked.plugins.warnings?.length)
            progress('\n' + checked.plugins.warnings.join('\n'));
        }
      } finally {
        if (changes) await lease(false).catch(() => {});
      }
      const warnings = JSON.parse(process.env.ASTRAL_PACKAGE_WARNINGS || '[]');
      return {
        content: [
          {
            type: 'text',
            text:
              (output || '操作完成。') +
              `\nPi 宿主 Node：${process.version}；Bash 为独立离线沙箱。` +
              (warnings.length ? '\n插件提示：' + warnings.join('；') : ''),
          },
        ],
        details: {
          summary:
            action === 'list'
              ? '已列出 Pi 包'
              : action === 'check'
                ? '插件组合检查通过'
                : '插件变更已验证并启用',
        },
      };
    },
  });
}
