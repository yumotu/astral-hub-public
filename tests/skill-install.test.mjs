import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProjectFiles } from '../deploy/pi/project-files.mjs';
import { createSkillStore } from '../deploy/pi/skill-store.mjs';
import { createSkillInstaller } from '../deploy/pi/skill-install.mjs';
import { skillRequest } from '../deploy/pi/skill-command.mjs';
import { sandboxArgs } from '../deploy/pi/bash-sandbox.mjs';
// Parser behavior is checked with Pi's actual YAML parser in the Linux acceptance test.
const parseFixture = (text) => {
  const end = text.indexOf('\n---', 4);
  return { frontmatter: JSON.parse(text.slice(4, end)), body: text.slice(end + 4).trim() };
};
const document = (name, body = '执行检查', extra = {}) =>
  '---\n' + JSON.stringify({ name, description: '测试技能', ...extra }) + '\n---\n' + body;
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'astral-install-')),
    root = join(dir, 'project');
  await mkdir(root);
  const store = createSkillStore(join(dir, 'library'));
  const files = createProjectFiles({
    projects: [{ id: 'main', root, readOnly: false }],
    backupDir: join(dir, 'backup'),
  });
  t.after(() => rm(dir, { recursive: true, force: true }));
  return {
    dir,
    root,
    store,
    files,
    install: createSkillInstaller({ files, store, parseFrontmatter: parseFixture }),
  };
}
test('project skill import persists standard documents and resources; repeat import never overwrites', async (t) => {
  const { dir, root, store, install } = await fixture(t);
  const folder = join(root, 'skills', 'pdf-reader');
  await mkdir(join(folder, 'scripts'), { recursive: true });
  const text = document('pdf-reader', '执行 scripts/check.py', {
    license: 'MIT',
    metadata: { author: 'fixture' },
  });
  await writeFile(join(folder, 'SKILL.md'), text);
  await writeFile(join(folder, 'scripts', 'check.py'), 'print(731)');
  await writeFile(join(folder, '.env'), 'SECRET=not-imported');
  const r = await install('main', 'skills');
  assert.equal(r.installed.length, 1);
  assert.equal(r.errors.length, 0);
  assert.equal(r.installed[0].resourceCount, 1);
  const path = join(dir, 'library', 'pdf-reader');
  assert.equal(await readFile(join(path, 'SKILL.md'), 'utf8'), text);
  assert.equal(await readFile(join(path, 'scripts', 'check.py'), 'utf8'), 'print(731)');
  await assert.rejects(() => readFile(join(path, '.env')));
  const again = await install('main', 'skills');
  assert.equal(again.installed.length, 0);
  assert.equal(again.skipped[0].name, 'pdf-reader');
  const item = (await store.list())[0];
  await store.save({ ...item, instructions: '更新说明' });
  assert.match(await readFile(join(path, 'SKILL.md'), 'utf8'), /MIT/);
  assert.equal((await store.list())[0].resources.length, 1);
  assert.equal(await readFile(join(path, 'scripts', 'check.py'), 'utf8'), 'print(731)');
  const mounts = await store.mounts();
  const args = await sandboxArgs([{ id: 'main', root, readOnly: false }], root, 'pwd', mounts);
  assert.ok(args.includes('/skills/pdf-reader'));
  assert.equal(args[args.indexOf(mounts[0].path) - 1], '--ro-bind');
  await store.save({ ...item, enabled: false });
  assert.deepEqual(await store.mounts(), []);
});
test('imports reject paths outside the selected project, invalid metadata and linked skill roots', async (t) => {
  const { dir, root, store, install } = await fixture(t);
  await mkdir(join(root, 'bad'));
  await writeFile(join(root, 'bad', 'SKILL.md'), 'missing frontmatter');
  const bad = await install('main', 'bad');
  assert.equal(bad.installed.length, 0);
  assert.equal(bad.errors.length, 1);
  assert.deepEqual(await store.list(), []);
  await assert.rejects(() => install('main', '../elsewhere'), { status: 403 });
  await assert.rejects(() => install('other', 'bad'), { status: 404 });
  await mkdir(join(dir, 'outside'));
  await symlink(join(dir, 'outside'), join(root, 'link'));
  await assert.rejects(() => install('main', 'link'), { status: 403 });
  await assert.rejects(
    () =>
      store.save(
        { name: 'broken', description: 'fixture', instructions: 'body', enabled: true },
        {
          createOnly: true,
          resources: [{ path: '../escape', data: Buffer.from('no'), mode: 0o600 }],
        },
      ),
    { status: 400 },
  );
  assert.deepEqual(await store.list(), []);
});
test('slash install requests select the host import tool instead of invoking a shell installer', () => {
  for (const input of ['/skills 安装', '/skills install', '/skills import'])
    assert.match(skillRequest(input), /skill_install/);
  assert.match(skillRequest('/skills 安装 skills/pdf-reader'), /skills\/pdf-reader/);
  assert.match(skillRequest('/skills 安装'), /dry-run/);
  assert.equal(skillRequest('/skill:pdf-reader 检查文件'), '/skill:pdf-reader 检查文件');
  assert.equal(skillRequest('请介绍技能'), '请介绍技能');
  assert.match(skillRequest('/skills'), /skill_list/);
  assert.match(skillRequest('/skills'), /仅列出技能时不要修改/);
  assert.match(skillRequest('/skills 停用 pdf-reader'), /skill_manage/);
  assert.match(skillRequest('/skills 停用 pdf-reader'), /停用 pdf-reader/);
});
test('only Pi relaxes namespace profiles; the app retains Docker default profiles', async () => {
  const compose = await readFile(new URL('../deploy/compose.yml', import.meta.url), 'utf8');
  const [app, pi] = compose.split('\n  pi:\n');
  assert.match(app, /security_opt: \[no-new-privileges:true\]/);
  assert.doesNotMatch(app, /seccomp:unconfined|apparmor:unconfined/);
  assert.match(pi, /seccomp:unconfined/);
});
