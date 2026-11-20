import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sandboxArgs } from '../deploy/pi/bash-sandbox.mjs';
import { registerBashTools } from '../deploy/pi/bash-tools.mjs';
import registerProjectTools from '../deploy/pi/project-tools.mjs';

async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'astral-bash-continuation-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'project');
  await mkdir(root);
  const projects = [{ id: 'own', root, readOnly: false }];
  const manifest = join(dir, 'projects.json');
  await writeFile(manifest, JSON.stringify(projects));
  const env = {
    ASTRAL_PROJECT_ID: 'own',
    ASTRAL_PROJECT_ACCESS: 'edit',
    ASTRAL_PROJECTS_FILE: manifest,
    ASTRAL_PROJECT_BACKUPS: join(dir, 'backups'),
    ASTRAL_BASH_CACHE: join(dir, 'managed-cache'),
  };
  for (const [key, value] of Object.entries(env)) {
    const old = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (old === undefined) delete process.env[key];
      else process.env[key] = old;
    });
  }
  return { dir, root, projects, cacheDir: env.ASTRAL_BASH_CACHE };
}

test('Bash continues past twelve calls, validates every command and redacts streamed output', async (t) => {
  await fixture(t);
  const tools = new Map(),
    calls = [],
    updates = [];
  await registerBashTools({ registerTool: (x) => tools.set(x.name, x), on() {} }, () => ({
    name: 'bash',
    async execute(...args) {
      calls.push(args);
      args[3]?.({ content: [{ type: 'text', text: 'sk-' + 'x'.repeat(32) }] });
      return { content: [{ type: 'text', text: 'done' }], details: { exitCode: 0 } };
    },
  }));
  const controller = new AbortController(),
    tool = tools.get('bash');
  for (let i = 0; i < 25; i++)
    assert.equal(
      (
        await tool.execute(String(i), { command: 'echo synthetic' }, controller.signal, (x) =>
          updates.push(x),
        )
      ).details.exitCode,
      0,
    );
  assert.equal(calls.length, 25);
  assert.equal(calls[24][2], controller.signal);
  assert.equal(calls[24][1].timeout, 120);
  assert.match(updates[24].content[0].text, /已隐藏/);
  for (const params of [{ command: '' }, { command: 'pwd', timeout: 301 }])
    await assert.rejects(tool.execute('invalid', params), /命令应为|超时/);
  assert.equal(calls.length, 25);
});

test('file tools continue past sixty calls while keeping scope and cancellation checks', async (t) => {
  const { root } = await fixture(t);
  await writeFile(join(root, 'visible.txt'), 'synthetic');
  const tools = new Map();
  await registerProjectTools({ registerTool: (x) => tools.set(x.name, x), on() {} });
  const tool = tools.get('project_list');
  for (let i = 0; i < 65; i++)
    assert.equal((await tool.execute(String(i), {})).details.projectId, 'own');
  await assert.rejects(tool.execute('other', { projectId: 'other' }), /项目不存在/);
  await assert.rejects(tool.execute('private', { path: 'data' }), /受保护/);
  await assert.rejects(tool.execute('traversal', { path: '../' }), /受保护/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(tool.execute('cancel', {}, controller.signal), /取消/);
});

test('managed cache is mounted separately while original project data stays private', async (t) => {
  const { root, projects, cacheDir } = await fixture(t);
  await mkdir(join(root, 'data'));
  await writeFile(join(root, 'data', 'secret.txt'), 'synthetic private data');
  const args = await sandboxArgs(projects, root, 'pwd', [], { cacheDir });
  assert.ok(
    args.some(
      (x, i) => x === '--bind' && args[i + 1] === cacheDir && args[i + 2] === '/home/agent/.cache',
    ),
  );
  assert.ok(
    args.some(
      (x, i) =>
        x === '--setenv' &&
        args[i + 1] === 'XDG_CACHE_HOME' &&
        args[i + 2] === '/home/agent/.cache',
    ),
  );
  assert.ok(
    args.some(
      (x, i) =>
        x === '--tmpfs' && args[i + 1] === join(root, 'data') && args[i + 2] === '--remount-ro',
    ),
  );
  assert.equal(args.includes('--share-net'), false);
  const readonly = projects.map((p) => ({ ...p, readOnly: true }));
  await assert.rejects(sandboxArgs(readonly, root, 'pwd', [], { cacheDir }), /智能体模式/);
});

test('managed cache rejects links, project overlaps and relative paths', async (t) => {
  const { root, projects, cacheDir, dir } = await fixture(t);
  await mkdir(join(dir, 'unrelated'));
  await symlink(join(dir, 'unrelated'), cacheDir);
  for (const value of [cacheDir, 'relative-cache', root, join(root, 'cache')])
    await assert.rejects(sandboxArgs(projects, root, 'pwd', [], { cacheDir: value }), /缓存/);
});
