import {
  readFile,
  writeFile,
  mkdir,
  lstat,
  realpath,
  rm,
  mkdtemp,
  cp,
  readdir,
} from 'node:fs/promises';
import { dirname, join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseOnlinePackage } from './assets/computer-package.mjs';
import { changePackages, recoverPackagesForTurn } from './assets/package-transaction.mjs';
import { leasePackages } from './package-leases.mjs';
import { loadConfig } from './config.mjs';
import { checkGrant } from './workspace.mjs';
import { localEnvironment, terminateTree } from './process-tree.mjs';

export const onlinePackageRoot = (configPath) => join(dirname(configPath), 'online-packages');
export function projectPackageRoot(configPath, project) {
  if (!/^[a-f0-9-]{36}$/i.test(project)) throw Error('插件项目编号不正确。');
  return join(onlinePackageRoot(configPath), project);
}
async function readState(root) {
  try {
    const st = await lstat(join(root, 'astral-packages.json'));
    if (!st.isFile() || st.isSymbolicLink() || st.nlink > 1 || st.size > 262144)
      throw Error('插件状态文件异常。');
    const state = JSON.parse(await readFile(join(root, 'astral-packages.json'), 'utf8'));
    if (
      !/^[a-f0-9-]{36}$/i.test(state.revision) ||
      !Array.isArray(state.packages) ||
      state.packages.length > 16
    )
      throw Error('插件配置不正确。');
    state.packages = state.packages.map((p) => ({
      ...parseOnlinePackage({ name: p.name, version: p.version, integrity: p.integrity }),
      enabled: p.enabled === true,
    }));
    if (new Set(state.packages.map((p) => p.name)).size !== state.packages.length)
      throw Error('插件包重复。');
    return state;
  } catch (e) {
    if (e.code === 'ENOENT') return { revision: 'new', packages: [] };
    throw e;
  }
}
export async function installedPackageRuntime(configPath, project, execute) {
  const root = projectPackageRoot(configPath, project);
  await recoverPackagesForTurn(root);
  const state = await readState(root);
  if (!execute) return { state, roots: [], tools: [] };
  const active = state.packages.filter((p) => p.enabled);
  const roots = await Promise.all(
    active.map(async (p) => {
      const dir = join(root, 'node_modules', p.name),
        manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
      if (manifest.name !== p.name || manifest.version !== p.version)
        throw Error('插件安装内容与已确认版本不同，请重新检查。');
      return realpath(dir);
    }),
  );
  const activation = active.length
    ? JSON.parse(await readFile(join(root, '.activation.json'), 'utf8'))
    : { tools: [] };
  if (active.length && activation.revision !== state.revision)
    throw Error('插件组合尚未通过启用检查。');
  return { state, roots, tools: activation.tools || [] };
}
async function runNode(file, args, { cwd, env, signal, timeout = 180000 } = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [file, ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    let tail = '',
      stopped = false;
    const finish = () => {
      stopped = true;
      terminateTree(child, true);
    };
    const timer = setTimeout(finish, timeout);
    signal?.addEventListener('abort', finish, { once: true });
    for (const pipe of [child.stdout, child.stderr])
      pipe.on('data', (c) => {
        tail = (tail + c).slice(-6000);
      });
    child.on('error', (e) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      code === 0 && !stopped
        ? accept(tail)
        : reject(Error(stopped ? '安装/检查已中断，原插件保留。' : '插件安装或加载失败：' + tail));
    });
    if (signal?.aborted) finish();
  });
}
async function npmCli() {
  const candidates = [
    join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
  ];
  for (const dir of (process.env.PATH || '').split(delimiter))
    candidates.push(
      join(dir, process.platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : 'npm'),
    );
  for (const path of candidates)
    try {
      const file = await realpath(path);
      if (file.endsWith('npm-cli.js')) return file;
    } catch {}
  throw Error('电脑未找到npm，请使用包含npm的Node.js安装。');
}
export function createOnlinePackageStore(
  configPath,
  { install, probe, fetch: fetcher = fetch } = {},
) {
  async function snapshot(project) {
    const root = projectPackageRoot(configPath, project);
    const state = await readState(root);
    const activation =
      state.revision === 'new'
        ? {}
        : JSON.parse(await readFile(join(root, '.activation.json'), 'utf8'));
    let canRollback = false;
    try {
      canRollback = (await readState(root + '.previous')).revision !== 'new';
    } catch {}
    return { ...state, activation, canRollback };
  }
  return {
    list: snapshot,
    async apply(grant, op, signal) {
      const fresh = async () => {
        const g = await checkGrant(
          (await loadConfig(configPath)).projects.find((p) => p.id === grant.id),
        );
        if (g.root !== grant.root || g.ino !== grant.ino || g.dev !== grant.dev || !g.allowExecute)
          throw Error('本机未授权插件安装/执行，或项目授权已变化。');
        return g;
      };
      await fresh();
      const unlock = await leasePackages(configPath, grant.id, 'write');
      const root = projectPackageRoot(configPath, grant.id);
      const home = await mkdtemp(join(tmpdir(), 'astral-package-'));
      try {
        await recoverPackagesForTurn(root);
        const current = await readState(root);
        if (current.revision !== op.expectedRevision)
          throw Error('插件组合已变化，请刷新后再操作。');
        let entries = current.packages.map((p) => ({ ...p }));
        if (op.kind === 'package_install') {
          const p = parseOnlinePackage(op.package);
          const response = await fetcher(
            'https://registry.npmjs.org/' + encodeURIComponent(p.name) + '/' + p.version,
            {
              redirect: 'error',
              signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15000)]),
            },
          );
          if (!response.ok) throw Error('电脑无法核验npm固定版本。');
          const metadata = await response.json();
          if (
            metadata.name !== p.name ||
            metadata.version !== p.version ||
            metadata.dist?.integrity !== p.integrity
          )
            throw Error('npm包校验已变化，需重新预览。');
          entries = entries.filter((x) => x.name !== p.name);
          entries.push({ ...p, enabled: true });
          if (entries.length > 16) throw Error('每个项目最多16个网上插件。');
        } else if (op.kind === 'package_enable') {
          const p = entries.find((p) => p.name === op.name);
          if (!p) throw Error('此项目没有这个插件。');
          p.enabled = op.enabled;
        } else if (op.kind === 'package_remove') {
          if (!entries.some((p) => p.name === op.name)) throw Error('此项目没有这个插件。');
          entries = entries.filter((p) => p.name !== op.name);
        } else if (op.kind === 'package_rollback') {
          const old = await readState(root + '.previous');
          if (old.revision === 'new') throw Error('没有可回滚的插件组合。');
          entries = old.packages;
        } else throw Error('不支持的插件变更。');
        const state = { revision: randomUUID(), packages: entries };
        const env = {
          ...localEnvironment(),
          HOME: home,
          USERPROFILE: home,
          PI_CODING_AGENT_DIR: home,
          PI_OFFLINE: '1',
          PI_TELEMETRY: '0',
          npm_config_userconfig: join(home, 'npmrc'),
          npm_config_globalconfig: join(home, 'global-npmrc'),
          npm_config_cache: join(home, 'cache'),
          npm_config_ignore_scripts: 'true',
          npm_config_audit: 'false',
          npm_config_fund: 'false',
          npm_config_registry: 'https://registry.npmjs.org/',
          ASTRAL_DEVICE_CONFIG: configPath,
          ASTRAL_DEVICE_PROJECT: grant.id,
          ASTRAL_DEVICE_ROOT: grant.root,
          ASTRAL_DEVICE_INO: String(grant.ino),
          ASTRAL_DEVICE_DEV: String(grant.dev),
          ASTRAL_DEVICE_EXECUTE: '1',
          ASTRAL_PROJECT_ACCESS: grant.allowWrite ? 'edit' : 'read',
          ASTRAL_PROJECT_ID: 'device',
          ASTRAL_PROJECT_BACKUPS: join(dirname(configPath), 'project-backups'),
          ASTRAL_PROJECTS_FILE: join(home, 'projects.json'),
          ASTRAL_PROJECT_PRIVATE_PATHS: JSON.stringify([
            configPath,
            onlinePackageRoot(configPath),
            home,
          ]),
        };
        await writeFile(
          join(home, 'npmrc'),
          'ignore-scripts=true\nregistry=https://registry.npmjs.org/\n',
          { mode: 0o600 },
        );
        await writeFile(join(home, 'global-npmrc'), '\n', { mode: 0o600 });
        await writeFile(
          join(home, 'projects.json'),
          JSON.stringify([
            {
              id: 'device',
              name: grant.name,
              root: grant.root,
              canonicalRoot: grant.root,
              readOnly: !grant.allowWrite,
            },
          ]),
          { mode: 0o600 },
        );
        await changePackages(root, {
          signal,
          async mutate(candidate) {
            if (op.kind === 'package_rollback') {
              for (const file of await readdir(candidate))
                await rm(join(candidate, file), { recursive: true, force: true });
              await cp(root + '.previous', candidate, { recursive: true, verbatimSymlinks: true });
            }
            await writeFile(
              join(candidate, 'package.json'),
              JSON.stringify({
                name: 'astral-project-packages',
                version: '1.0.0',
                private: true,
                dependencies: Object.fromEntries(entries.map((p) => [p.name, p.version])),
              }),
              { mode: 0o600 },
            );
            await writeFile(join(candidate, 'astral-packages.json'), JSON.stringify(state), {
              mode: 0o600,
            });
            if (['package_install', 'package_remove'].includes(op.kind)) {
              if (install) await install(candidate, entries, env, signal);
              else
                await runNode(
                  await npmCli(),
                  [
                    'install',
                    '--ignore-scripts',
                    '--no-audit',
                    '--no-fund',
                    '--legacy-peer-deps',
                    '--registry=https://registry.npmjs.org/',
                  ],
                  { cwd: candidate, env, signal },
                );
            }
            const lock = JSON.parse(await readFile(join(candidate, 'package-lock.json'), 'utf8'));
            for (const p of entries)
              if (lock.packages?.['node_modules/' + p.name]?.integrity !== p.integrity)
                throw Error('安装的包校验与预览不一致。');
          },
          async validate(candidate) {
            await fresh();
            const roots = entries
              .filter((p) => p.enabled)
              .map((p) => join(candidate, 'node_modules', p.name));
            env.ASTRAL_PACKAGE_ROOTS = JSON.stringify(roots);
            let checked;
            if (probe) checked = await probe(candidate, roots, env, signal);
            else {
              const output = join(home, 'result.json'),
                input = join(home, 'probe.json');
              await writeFile(input, JSON.stringify({ cwd: grant.root, home, roots, output }), {
                mode: 0o600,
              });
              try {
                await runNode(
                  fileURLToPath(new URL('./package-probe.mjs', import.meta.url)),
                  [input],
                  { cwd: home, env, signal, timeout: 45000 },
                );
              } catch (e) {
                try {
                  const r = JSON.parse(await readFile(output, 'utf8'));
                  throw Error(r.error || e.message);
                } catch (inner) {
                  if (inner.code) throw e;
                  throw inner;
                }
              }
              checked = JSON.parse(await readFile(output, 'utf8'));
            }
            if (!checked.ready) throw Error(checked.error || '插件加载未通过。');
            await fresh();
            await writeFile(
              join(candidate, '.activation.json'),
              JSON.stringify({ ...checked, revision: state.revision }),
              { mode: 0o600 },
            );
            return checked;
          },
        });
        return {
          ...(await snapshot(grant.id)),
          summary:
            '插件组合已保存并通过Pi加载检查，从下一项允许执行命令的任务生效。运行依赖和第三方界面仍以实际调用结果为准。',
        };
      } finally {
        await rm(home, { recursive: true, force: true });
        await unlock();
      }
    },
  };
}
