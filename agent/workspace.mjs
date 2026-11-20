import { DatabaseSync } from 'node:sqlite';
import { mkdir, chmod, lstat, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createProjectFiles } from './assets/project-files.mjs';
import { createComputerPluginStore } from './plugin-store.mjs';
import { createOnlinePackageStore, onlinePackageRoot } from './online-packages.mjs';
export async function checkGrant(project) {
  if (!project) throw Error('本机已撤销此项目授权。');
  const info = await lstat(project.root);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (await realpath(project.root)) !== project.root ||
    (project.ino !== undefined && (info.ino !== project.ino || info.dev !== project.dev))
  )
    throw Error('项目实际目录已变化，请在本机重新授权。');
  return project;
}
export async function createLocalWorkspace({
  projects,
  backupDir,
  ledgerFile,
  terminals,
  protectedPaths = [],
  configPath,
}) {
  await mkdir(dirname(ledgerFile), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(ledgerFile);
  await chmod(ledgerFile, 0o600);
  db.exec(
    'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,input TEXT NOT NULL,status TEXT NOT NULL,result TEXT,error TEXT)',
  );
  const plugins = configPath ? createComputerPluginStore(configPath) : null;
  const packages = configPath ? createOnlinePackageStore(configPath) : null;
  return {
    async handle(op, signal) {
      const input = JSON.stringify(op),
        old = db.prepare('SELECT * FROM operations WHERE id=?').get(op.id);
      if (old) {
        if (old.input !== input) throw Error('请求编号与本机记录不一致。');
        if (old.status !== 'done') throw Error(old.error || '上次请求结果未知，不会自动重放。');
        return JSON.parse(old.result);
      }
      const p = await checkGrant(projects().find((p) => p.id === op.projectId));
      const files = createProjectFiles({
        projects: [
          { id: p.id, name: p.name, root: p.root, canonicalRoot: p.root, readOnly: !p.allowWrite },
        ],
        backupDir,
        protectedPaths: [
          ledgerFile,
          backupDir,
          ...(configPath ? [onlinePackageRoot(configPath)] : []),
          ...protectedPaths,
        ],
      });
      if (
        ![
          'list',
          'read',
          'write',
          'mkdir',
          'restore',
          'download',
          'terminal_open',
          'terminal_input',
          'terminal_resize',
          'terminal_close',
          'plugin_list',
          'plugin_register',
          'plugin_remove',
          'package_list',
          'package_install',
          'package_enable',
          'package_remove',
          'package_rollback',
        ].includes(op.kind)
      )
        throw Error('不支持的电脑文件操作。');
      db.prepare("INSERT INTO operations VALUES(?,?,'started',NULL,NULL)").run(op.id, input);
      try {
        let result;
        if (op.kind.startsWith('package_')) {
          if (!packages) throw Error('网上插件功能尚未初始化。');
          result =
            op.kind === 'package_list'
              ? await packages.list(p.id)
              : await packages.apply(p, op, signal);
        } else if (op.kind.startsWith('plugin_')) {
          if (!plugins) throw Error('电脑插件功能未初始化，请同步执行器工具补丁。');
          result =
            op.kind === 'plugin_list'
              ? { plugins: await plugins.list(p.id) }
              : await plugins.apply(p, op);
        } else if (op.kind.startsWith('terminal_')) {
          if (!terminals || !p.allowExecute) throw Error('本机未授权终端。');
          result = await terminals.handle(op, p);
        } else {
          switch (op.kind) {
            case 'list':
              result = await files.list(p.id, op.path);
              break;
            case 'read':
              new TextDecoder('utf-8', { fatal: true }).decode(
                await files.exportFile(p.id, op.path),
              );
              result = await files.document(p.id, op.path);
              break;
            case 'write':
              if (!p.allowWrite) throw Error('本机项目仅允许读取。');
              result = await files.write(p.id, op.path, op.content, op.expectedHash, 'edit');
              break;
            case 'mkdir':
              if (!p.allowWrite) throw Error('本机项目仅允许读取。');
              result = await files.mkdir(p.id, op.path);
              break;
            case 'restore':
              if (!p.allowWrite) throw Error('本机项目仅允许读取。');
              result = await files.restore(p.id, op.backupId, 'edit');
              break;
            case 'download': {
              const data = await files.exportFile(p.id, op.path);
              if (data.length > 1048576) throw Error('电脑文件下载上限为1 MiB。');
              result = { path: op.path, base64: data.toString('base64'), bytes: data.length };
              break;
            }
          }
        }
        db.prepare("UPDATE operations SET status='done',result=? WHERE id=?").run(
          JSON.stringify(result),
          op.id,
        );
        return result;
      } catch (e) {
        db.prepare("UPDATE operations SET status='error',error=? WHERE id=?").run(
          String(e.message).slice(0, 1000),
          op.id,
        );
        throw e;
      }
    },
    close() {
      db.close();
    },
  };
}
