import { mkdir, readFile, writeFile, cp, rm, symlink } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { unzipSync } from 'fflate';
import { buildAgent } from './package-agent.mjs';
process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const version = '26.7.0',
  platform = process.platform;
if (!['darwin', 'win32', 'linux'].includes(platform)) throw Error('Unsupported desktop platform');
const arches = process.argv.includes('--host-only')
  ? [process.arch]
  : platform === 'darwin'
    ? ['arm64', 'x64']
    : ['x64'];
const prefix = `https://nodejs.org/dist/v${version}/`;
const checksum = spawnSync(
  'curl',
  [
    '--fail',
    '--silent',
    '--show-error',
    '--location',
    '--max-time',
    '45',
    prefix + 'SHASUMS256.txt',
  ],
  { encoding: 'utf8', windowsHide: true },
);
if (checksum.status !== 0) throw Error('Official Node checksums could not be downloaded');
const sums = checksum.stdout;
const agent = buildAgent(),
  files = unzipSync(agent.bytes),
  root = resolve('desktop/runtime');
const run = (exe, args, options = {}) => {
  const r = spawnSync(exe, args, { stdio: 'inherit', windowsHide: true, ...options });
  if (r.status !== 0)
    throw Error(
      'Bundled runtime command failed: ' + args[0] + ' ' + (r.error?.message || r.status),
    );
};
for (const arch of arches) {
  const name = `node-v${version}-${platform === 'win32' ? 'win' : platform}-${arch}.${platform === 'win32' ? 'zip' : 'tar.gz'}`;
  const sha = sums
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .find((l) => l[1] === name)?.[0];
  if (!/^[a-f0-9]{64}$/.test(sha || '')) throw Error('Official Node checksum missing');
  const cache = resolve('release/runtime-cache', name);
  await mkdir(dirname(cache), { recursive: true });
  let bytes;
  try {
    bytes = await readFile(cache);
  } catch {}
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== sha) {
    const response = spawnSync(
      'curl',
      [
        '--fail',
        '--silent',
        '--show-error',
        '--location',
        '--max-time',
        '180',
        '--output',
        cache + '.next',
        prefix + name,
      ],
      { stdio: 'inherit', windowsHide: true },
    );
    if (response.status !== 0) throw Error('Node runtime download failed');
    bytes = await readFile(cache + '.next');
    await rm(cache + '.next');
    if (createHash('sha256').update(bytes).digest('hex') !== sha)
      throw Error('Node archive hash mismatch');
    await writeFile(cache, bytes);
  }
  const stage = join(root, arch);
  await rm(stage, { recursive: true, force: true });
  await mkdir(join(stage, 'runtime'), { recursive: true });
  if (platform === 'win32') {
    for (const [name, data] of Object.entries(unzipSync(bytes))) {
      const rel = name.split('/').slice(1).join('/');
      if (!rel || rel.endsWith('/')) continue;
      if (rel.split('/').includes('..')) throw Error('Invalid runtime path');
      const path = join(stage, 'runtime', rel);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, data);
    }
  } else run('tar', ['-xzf', cache, '--strip-components=1', '-C', join(stage, 'runtime')]);
  for (const [name, data] of Object.entries(files)) {
    const rel = name.replace(/^astral-remote-pi-agent\//, '');
    if (!rel || rel.split('/').includes('..')) throw Error('Invalid agent path');
    const path = join(stage, 'agent', rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }
  const node = join(stage, 'runtime', platform === 'win32' ? 'node.exe' : 'bin/node'),
    npm = join(
      stage,
      'runtime',
      platform === 'win32'
        ? 'node_modules/npm/bin/npm-cli.js'
        : 'lib/node_modules/npm/bin/npm-cli.js',
    );
  const env = {
    ...process.env,
    PATH: dirname(node) + (platform === 'win32' ? ';' : ':') + process.env.PATH,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  run(node, [npm, 'ci', '--ignore-scripts', '--omit=dev'], { cwd: join(stage, 'agent'), env });
  run(node, [npm, 'rebuild', 'node-pty'], { cwd: join(stage, 'agent'), env });
  run(node, ['prepare-terminal.mjs'], { cwd: join(stage, 'agent'), env });
  run(node, ['relay-agent.mjs', '--help'], { cwd: join(stage, 'agent'), env });
  await cp(resolve('agent/tests'), join(stage, 'agent/tests'), { recursive: true });
  const links = ['server', 'shared', 'tests'];
  try {
    for (const name of links)
      await symlink(
        resolve(name),
        join(stage, name),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    run(
      node,
      [
        '--test',
        ...[
          'runtime.test.mjs',
          'relay-integration.test.mjs',
          'computer-tools.test.mjs',
          'plugins.test.mjs',
          'online-packages.test.mjs',
          'inputs.test.mjs',
        ].map((n) => join(stage, 'agent/tests', n)),
      ],
      { env },
    );
  } finally {
    await rm(join(stage, 'agent/tests'), { recursive: true, force: true });
    for (const name of links) await rm(join(stage, name), { recursive: true, force: true });
  }
  const details = spawnSync(
    node,
    ['-p', 'JSON.stringify({node:process.versions.node,arch:process.arch})'],
    { encoding: 'utf8', env, windowsHide: true },
  );
  if (details.status !== 0) throw Error('Bundled Node cannot run on build host');
  const actual = JSON.parse(details.stdout);
  if (actual.node !== version || actual.arch !== arch)
    throw Error('Bundled Node version or architecture mismatch');
  await writeFile(
    join(stage, 'manifest.json'),
    JSON.stringify(
      { version: agent.version, node: version, platform, arch, archive: name, archiveSha256: sha },
      null,
      2,
    ) + '\n',
  );
  console.log('Desktop computer runtime verified:', platform, arch, agent.version);
}
