import { spawn } from 'node:child_process';
import { lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
const privateName =
  /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|id_rsa.*|id_ed25519.*|auth\.json|credentials(?:\..*)?)$|\.(?:pem|key|p12|pfx|keystore|jks|sqlite|sqlite3|db|log)$/i;
const privateDirs = new Set([
  '.ssh',
  '.aws',
  '.config',
  '.pi',
  'data',
  'backups',
  'release',
  'private',
]);
export function validCommand(command, timeout = 120) {
  if (
    typeof command !== 'string' ||
    !command.trim() ||
    command.length > 8000 ||
    command.includes('\0')
  )
    throw new Error('命令应为 1–8000 个字符。');
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 300)
    throw new Error('Bash 超时必须大于 0 且不超过 300 秒。');
  return timeout;
}
export async function sandboxArgs(
  projects,
  cwd,
  command,
  skills = [],
  { network = false, cacheDir } = {},
) {
  const selected = projects.find((p) => cwd === p.root);
  if (!selected || selected.readOnly) throw new Error('请在可写项目中选择智能体模式后运行 Bash。');
  const args = [
    '--die-with-parent',
    '--new-session',
    '--unshare-all',
    '--cap-drop',
    'ALL',
    '--clearenv',
    '--ro-bind',
    '/usr',
    '/usr',
    '--ro-bind',
    '/bin',
    '/bin',
    '--ro-bind',
    '/lib',
    '/lib',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    '--dir',
    '/home/agent',
    '--setenv',
    'HOME',
    '/home/agent',
    '--setenv',
    'PATH',
    '/usr/local/bin:/usr/bin:/bin',
    '--setenv',
    'LANG',
    'C.UTF-8',
    '--setenv',
    'TERM',
    'dumb',
    '--setenv',
    'CI',
    '1',
    '--setenv',
    'NODE_OPTIONS',
    '--max-old-space-size=192',
  ];
  if (network) {
    args.splice(3, 0, '--share-net');
    args.push(
      '--ro-bind',
      '/etc/resolv.conf',
      '/etc/resolv.conf',
      '--ro-bind',
      '/etc/hosts',
      '/etc/hosts',
      '--ro-bind-try',
      '/etc/ssl',
      '/etc/ssl',
    );
  }
  const masks = [];
  let scanned = 0;
  // Parent mounts already expose nested project folders; avoid duplicate mounts and masks.
  const mounts = [...projects]
    .sort((a, b) => a.root.length - b.root.length)
    .filter(
      (p, i, all) =>
        !all
          .slice(0, i)
          .some(
            (parent) =>
              parent.readOnly === p.readOnly &&
              (p.root === parent.root || p.root.startsWith(parent.root + '/')),
          ),
    );
  for (const p of mounts) {
    if (
      !isAbsolute(p.root) ||
      p.root === '/' ||
      resolve(p.root) !== p.root ||
      (await lstat(p.root)).isSymbolicLink()
    )
      throw new Error('项目挂载路径不正确。');
    if (p.canonicalRoot && (await realpath(p.root)) !== p.canonicalRoot)
      throw new Error('项目实际路径已变化，不能挂载。');
    args.push(p.readOnly ? '--ro-bind' : '--bind', p.root, p.root);
    async function walk(path, depth = 0) {
      if (depth > 24) throw new Error('项目层级过深，无法建立命令隔离。');
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (++scanned > 30000) throw new Error('项目文件过多，无法建立命令隔离。');
        const target = join(path, entry.name);
        if (privateDirs.has(entry.name) || privateName.test(entry.name)) {
          masks.push(
            entry.isDirectory()
              ? ['--tmpfs', target, '--remount-ro', target]
              : ['--ro-bind', '/dev/null', target],
          );
        } else if (entry.isDirectory() && !['node_modules', '.git'].includes(entry.name))
          await walk(target, depth + 1);
      }
    }
    await walk(p.root);
  }
  for (const mask of masks) args.push(...mask);
  if (cacheDir) {
    // The bridge supplies a private, conversation/project-scoped directory. Only
    // this cache is exposed, never the surrounding native session or credentials.
    // Keep all project masks intact: tools such as Tectonic use cache/data, which
    // must not be mistaken for an application's protected project data directory.
    const overlaps = (root) =>
      cacheDir === root || cacheDir.startsWith(root + '/') || root.startsWith(cacheDir + '/');
    if (
      !isAbsolute(cacheDir) ||
      resolve(cacheDir) !== cacheDir ||
      cacheDir === '/' ||
      projects.some((p) => overlaps(p.root)) ||
      skills.some((s) => overlaps(s.path))
    )
      throw new Error('命令缓存路径不正确。');
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    const info = await lstat(cacheDir);
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(cacheDir)) !== cacheDir)
      throw new Error('命令缓存不能使用链接或变化的路径。');
    args.push(
      '--bind',
      cacheDir,
      '/home/agent/.cache',
      '--setenv',
      'XDG_CACHE_HOME',
      '/home/agent/.cache',
    );
  }
  for (const skill of skills) {
    if (
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name) ||
      !isAbsolute(skill.path) ||
      (await lstat(skill.path)).isSymbolicLink()
    )
      throw new Error('技能挂载路径不正确。');
    args.push(
      '--ro-bind',
      skill.path,
      skill.path,
      '--ro-bind',
      skill.path,
      `/skills/${skill.name}`,
    );
  }
  args.push(
    '--chdir',
    cwd,
    '--',
    '/bin/bash',
    '--noprofile',
    '--norc',
    '-c',
    'ulimit -H -S -t 90; ulimit -H -S -f 32768; ulimit -H -S -n 128; exec /bin/bash --noprofile --norc -c "$1"',
    'astral-bash',
    command,
  );
  return args;
}
export function createSandboxOperations(
  projects,
  cwd,
  {
    getSkillMounts = async () => [],
    getNetworkPolicy = async () => ({ enabled: false, version: 0, expiresAt: null }),
    spawnProcess = spawn,
    networkPollMs = 2000,
    cacheDir,
  } = {},
) {
  return {
    async exec(command, _cwd, { onData, signal, timeout = 120 }) {
      validCommand(command, timeout);
      if (signal?.aborted) throw new Error('aborted');
      const policy = await getNetworkPolicy();
      const network = policy.enabled === true && policy.expiresAt > Date.now();
      const args = await sandboxArgs(projects, cwd, command, await getSkillMounts(), {
        network,
        cacheDir,
      });
      if (network) {
        const current = await getNetworkPolicy();
        if (
          !current.enabled ||
          current.version !== policy.version ||
          current.expiresAt <= Date.now()
        )
          throw new Error('联网授权已变化，命令未启动。');
      }
      if (signal?.aborted) throw new Error('aborted');
      return new Promise((resolve, reject) => {
        const child = spawnProcess('/usr/bin/bwrap', args, {
          env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        });
        let timedOut = false,
          size = 0,
          excessive = false,
          networkRevoked = false,
          checkingNetwork = false,
          finished = false;
        const kill = () => {
          if (finished) return;
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        };
        const timer = setTimeout(() => {
          timedOut = true;
          kill();
        }, timeout * 1000);
        const networkTimer = network
          ? setInterval(async () => {
              if (checkingNetwork) return;
              checkingNetwork = true;
              try {
                const current = await getNetworkPolicy();
                if (finished) return;
                if (
                  !current.enabled ||
                  current.version !== policy.version ||
                  current.expiresAt <= Date.now()
                ) {
                  networkRevoked = true;
                  kill();
                }
              } catch {
                networkRevoked = true;
                kill();
              } finally {
                checkingNetwork = false;
              }
            }, networkPollMs)
          : null;
        signal?.addEventListener('abort', kill, { once: true });
        if (signal?.aborted) kill();
        const clean = () => {
          finished = true;
          clearTimeout(timer);
          if (networkTimer) clearInterval(networkTimer);
          signal?.removeEventListener('abort', kill);
        };
        const data = (chunk) => {
          size += chunk.length;
          if (size > 1024 * 1024) {
            excessive = true;
            kill();
          } else onData(chunk);
        };
        child.stdout.on('data', data);
        child.stderr.on('data', data);
        child.once('error', (e) => {
          clean();
          reject(new Error(e.code === 'ENOENT' ? 'Bash 隔离运行时未安装。' : 'Bash 启动失败。'));
        });
        child.once('close', (code) => {
          clean();
          if (signal?.aborted) reject(new Error('aborted'));
          else if (networkRevoked)
            reject(
              new Error('联网授权已结束或无法确认，当前联网命令已停止；请核对已发生的修改后继续。'),
            );
          else if (timedOut) reject(new Error(`timeout:${timeout}`));
          else if (excessive) reject(new Error('命令输出超过 1 MiB，已停止。'));
          else resolve({ exitCode: code ?? 137 });
        });
      });
    },
  };
}
