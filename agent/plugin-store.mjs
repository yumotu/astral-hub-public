import { mkdir, lstat, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseComputerPlugin, pluginPermissions } from './assets/computer-plugin.mjs';
import { checkGrant } from './workspace.mjs';
import { lockProjectFile } from './assets/project-lock.mjs';
import { loadConfig } from './config.mjs';
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function createComputerPluginStore(configPath) {
  const root = join(dirname(configPath), 'plugins');
  async function path(project) {
    if (!/^[a-f0-9-]{36}$/i.test(project)) throw Error('插件项目编号不正确。');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    if (info.isSymbolicLink() || !info.isDirectory()) throw Error('电脑插件目录不正确。');
    return join(root, project + '.json');
  }
  async function load(project) {
    const file = await path(project);
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || info.size > 1024 * 1024)
        throw Error('电脑插件记录不正确。');
      const data = JSON.parse(await readFile(file, 'utf8'));
      if (!Array.isArray(data) || data.length > 32) throw Error('电脑插件记录不正确。');
      return data.map((item) => {
        const manifest = parseComputerPlugin(item.manifest);
        if (
          typeof item.enabled !== 'boolean' ||
          item.sha256 !== hash({ manifest, enabled: item.enabled })
        )
          throw Error('电脑插件校验失败。');
        return { manifest, enabled: item.enabled, sha256: item.sha256 };
      });
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  }
  return {
    list: load,
    async apply(grant, op) {
      await checkGrant(grant);
      const freshGrant = async () => {
        const current = await checkGrant(
          (await loadConfig(configPath)).projects.find((p) => p.id === grant.id),
        );
        if (current.root !== grant.root || current.ino !== grant.ino || current.dev !== grant.dev)
          throw Error('本机项目授权已变化。');
        return current;
      };
      const file = await path(grant.id);
      const unlock = await lockProjectFile(join(dirname(configPath), 'plugin-locks'), file);
      let temp;
      try {
        const items = await load(grant.id);
        const id =
          op.kind === 'plugin_register' ? parseComputerPlugin(op.manifest).id : op.pluginId;
        const previous = items.find((x) => x.manifest.id === id);
        if ((previous?.sha256 || 'new') !== op.expectedHash)
          throw Error('插件已变化，请重新读取后操作。');
        if (op.kind === 'plugin_register') {
          const manifest = parseComputerPlugin(op.manifest),
            permission = pluginPermissions(manifest);
          if (
            (permission.write && !grant.allowWrite) ||
            (permission.execute && !grant.allowExecute)
          )
            throw Error('本机未授权插件需要的修改或命令权限。');
          const item = {
            manifest,
            enabled: op.enabled,
            sha256: hash({ manifest, enabled: op.enabled }),
          };
          if (!previous && items.length >= 32) throw Error('每个项目最多注册32个电脑插件。');
          if (previous) items.splice(items.indexOf(previous), 1, item);
          else items.push(item);
        } else {
          if (!previous) throw Error('电脑插件不存在。');
          items.splice(items.indexOf(previous), 1);
        }
        temp = file + '.' + randomUUID() + '.tmp';
        await writeFile(temp, JSON.stringify(items), { mode: 0o600, flag: 'wx' });
        const fresh = await freshGrant();
        if (op.kind === 'plugin_register') {
          const permission = pluginPermissions(op.manifest);
          if (
            (permission.write && !fresh.allowWrite) ||
            (permission.execute && !fresh.allowExecute)
          )
            throw Error('本机已撤销插件需要的权限。');
        }
        await rename(temp, file);
        return {
          plugins: items,
          summary:
            op.kind === 'plugin_remove'
              ? '插件已删除，运行中的调用将停止后续步骤。'
              : '插件已保存，从下一任务加载。',
        };
      } finally {
        if (temp) await rm(temp, { force: true });
        await unlock();
      }
    },
  };
}
