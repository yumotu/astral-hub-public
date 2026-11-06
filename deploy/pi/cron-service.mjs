import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function installedCron(packagesRoot) {
  try {
    const settings = JSON.parse(await readFile(join(packagesRoot, 'settings.json'), 'utf8'));
    const enabled = settings.packages?.some(
      (p) =>
        /^npm:@patimweb\/pi-cron(?:@|$)/.test(typeof p === 'string' ? p : p.source || '') &&
        !(Array.isArray(p.extensions) && p.extensions.length === 0),
    );
    if (!enabled) {
      const configured = settings.packages?.some((p) =>
        /^npm:@patimweb\/pi-cron(?:@|$)/.test(typeof p === 'string' ? p : p.source || ''),
      );
      if (configured) return null;
      const root = '/extensions/node_modules/@patimweb/pi-cron';
      const meta = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
      return meta.version === '2.2.0' ? { root, version: meta.version } : null;
    }
    const root = join(packagesRoot, 'npm/node_modules/@patimweb/pi-cron');
    const meta = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    if (meta.version !== '2.2.0')
      throw new Error(`pi-cron ${meta.version} 尚未通过星屿适配验收，当前支持 2.2.0。`);
    return { root, version: meta.version };
  } catch (e) {
    if (e.code === 'ENOENT') {
      try {
        const root = '/extensions/node_modules/@patimweb/pi-cron',
          meta = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
        return meta.version === '2.2.0' ? { root, version: meta.version } : null;
      } catch {
        return null;
      }
    }
    throw e;
  }
}

export async function createCronService({ root, packagesRoot }) {
  const { attachJsonlLineReader } =
    await import('/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/jsonl.js');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const registryFile = join(root, 'owners.json');
  let owners = [];
  try {
    owners = JSON.parse(await readFile(registryFile, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (
    !Array.isArray(owners) ||
    owners.length > 10 ||
    owners.some((o) => !/^[a-f0-9-]{36}$/.test(o?.ownerId || ''))
  )
    throw new Error('插件宿主账号索引格式不正确。');
  const hosts = new Map();
  const starting = new Map();
  let closed = false,
    problem = '';
  async function stop(ownerId) {
    const host = hosts.get(ownerId);
    if (!host) return;
    hosts.delete(ownerId);
    host.child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        host.child.kill('SIGKILL');
        resolve();
      }, 3000);
      host.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  async function start(owner) {
    if (closed) throw new Error('插件宿主已关闭。');
    const pkg = await installedCron(packagesRoot);
    if (!pkg) throw new Error('请先安装 npm:@patimweb/pi-cron@2.2.0。');
    if (hosts.has(owner.ownerId)) return hosts.get(owner.ownerId);
    const dir = join(root, owner.ownerId);
    await mkdir(join(dir, 'home'), { recursive: true, mode: 0o700 });
    if (closed) throw new Error('插件宿主已关闭。');
    const child = spawn(process.execPath, ['/bridge/cron-host.mjs'], {
      env: {
        PATH: process.env.PATH,
        HOME: join(dir, 'home'),
        PI_CODING_AGENT_DIR: join(dir, 'home'),
        PI_CRON_HOME: join(dir, 'cron'),
        ASTRAL_CRON_PACKAGE: pkg.root,
        ASTRAL_OWNER_ID: owner.ownerId,
        TZ: owner.timeZone || 'Asia/Shanghai',
        NO_COLOR: '1',
        NODE_OPTIONS: '--max-old-space-size=160',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const host = { child, pending: new Map(), version: pkg.version, ready: false };
    hosts.set(owner.ownerId, host);
    const detach = attachJsonlLineReader(child.stdout, (line) => {
      try {
        const message = JSON.parse(line),
          waiter = host.pending.get(message.id);
        if (message.type === 'ready') host.ready = true;
        if (waiter) {
          host.pending.delete(message.id);
          clearTimeout(waiter.timer);
          message.error ? waiter.reject(new Error(message.error)) : waiter.resolve(message.result);
        }
      } catch {
        problem = '调度宿主返回了无效记录。';
      }
    });
    // Diagnostics may contain local paths; keep them out of chat and secrets out of logs.
    child.stderr.resume();
    child.stdin.on('error', () => {});
    const fail = () => {
      detach();
      if (hosts.get(owner.ownerId) === host) hosts.delete(owner.ownerId);
      for (const waiter of host.pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('调度宿主已退出，将自动恢复。'));
      }
      host.pending.clear();
    };
    child.once('exit', fail);
    child.once('error', fail);
    return host;
  }
  function ensure(owner) {
    if (hosts.has(owner.ownerId)) return Promise.resolve(hosts.get(owner.ownerId));
    if (starting.has(owner.ownerId)) return starting.get(owner.ownerId);
    const pending = start(owner).finally(() => starting.delete(owner.ownerId));
    starting.set(owner.ownerId, pending);
    return pending;
  }
  async function call(owner, data) {
    const host = await ensure(owner);
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        host.pending.delete(id);
        reject(new Error('调度宿主响应超时。'));
      }, 15000);
      host.pending.set(id, { resolve, reject, timer });
      host.child.stdin.write(JSON.stringify({ ...data, id }) + '\n');
    });
  }
  async function refresh() {
    try {
      const pkg = await installedCron(packagesRoot);
      if (!pkg) {
        for (const id of [...hosts.keys()]) await stop(id);
        return;
      }
      for (const owner of owners) await ensure(owner);
      problem = '';
    } catch (e) {
      problem = e.message;
      for (const id of [...hosts.keys()]) await stop(id);
    }
  }
  const timer = setInterval(() => {
    if (!closed) void refresh();
  }, 3000);
  timer.unref();
  await refresh();
  return {
    async register(ownerId, timeZone = 'Asia/Shanghai') {
      if (!/^[a-f0-9-]{36}$/.test(ownerId || ''))
        throw new Error('缺少已验证的账号标识，请升级星屿服务。');
      new Intl.DateTimeFormat('zh-CN', { timeZone });
      if (!owners.some((o) => o.ownerId === ownerId)) {
        if (owners.length >= 10) throw new Error('常驻插件宿主已达到上限。');
        owners.push({ ownerId, timeZone });
        await writeFile(registryFile + '.next', JSON.stringify(owners), { mode: 0o600 });
        await rename(registryFile + '.next', registryFile);
      }
      return { ownerId, timeZone: owners.find((o) => o.ownerId === ownerId).timeZone };
    },
    async request(context, data) {
      const owner = await this.register(context.ownerId, context.timeZone);
      return call(owner, { ...data, context });
    },
    async pending() {
      if (!(await installedCron(packagesRoot))) return { runs: [] };
      const runs = [];
      for (const owner of owners) runs.push(...(await call(owner, { action: 'pending' })).runs);
      return { runs: runs.slice(0, 100) };
    },
    async ack(run) {
      const owner = owners.find((o) => o.ownerId === run.ownerId);
      if (!owner) throw new Error('调度账号不存在。');
      return call(owner, { action: 'ack', run });
    },
    async closeConversation(ownerId, conversationId) {
      const owner = owners.find((o) => o.ownerId === ownerId);
      return owner ? call(owner, { action: 'close_conversation', conversationId }) : { ok: true };
    },
    status: () => ({
      activeHosts: [...hosts.values()].filter((h) => h.ready).length,
      registeredOwners: owners.length,
      error: problem,
    }),
    async close() {
      closed = true;
      clearInterval(timer);
      await Promise.allSettled([...starting.values()]);
      await Promise.all([...hosts.keys()].map(stop));
    },
  };
}
