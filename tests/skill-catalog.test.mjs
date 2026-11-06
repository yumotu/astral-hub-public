import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildSkillCatalog, packageSkillLocation } from '../deploy/pi/skill-catalog.mjs';

async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'astral-skill-catalog-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'managed');
  const native = join(dir, 'package', 'mermaid', 'SKILL.md');
  await mkdir(join(dir, 'package', 'mermaid'), { recursive: true });
  await writeFile(native, '---\nname: mermaid\ndescription: Draw diagrams\n---\nRead only.');
  const managed = [
    { name: 'review', description: 'Review code', enabled: true },
    { name: 'disabled', description: 'Disabled', enabled: false },
    { name: 'removed', description: 'Removed', enabled: false, archived: true },
  ];
  for (const skill of managed) {
    await mkdir(join(root, skill.name), { recursive: true });
    await writeFile(join(root, skill.name, 'SKILL.md'), skill.description);
  }
  const options = { root, managed, packagePaths: [native], cwd: dir, agentDir: dir, owner: true };
  // The production adapter supplies the fixed Pi SDK loader. Unit fixtures inject
  // its parsed result; the real loader and package combination are checked in QA.
  const loadSkills = ({ skillPaths, includeDefaults }) => {
    assert.equal(includeDefaults, false);
    return {
      skills: skillPaths.map((path) => ({
        filePath: path,
        name: path === native ? 'mermaid' : 'review',
        description: path === native ? 'Draw diagrams' : 'Review code',
        disableModelInvocation: path === native,
      })),
      diagnostics: [],
    };
  };
  return { dir, root, native, managed, options, loadSkills };
}

test('catalog includes native package skills with their actual paths and read-only source', async (t) => {
  const f = await fixture(t);
  const { skills } = await buildSkillCatalog({ ...f.options, loadSkills: f.loadSkills });
  assert.deepEqual(
    skills.map((s) => s.name),
    ['mermaid', 'review', 'disabled'],
  );
  assert.deepEqual(skills[0], {
    name: 'mermaid',
    description: 'Draw diagrams',
    path: f.native,
    enabled: true,
    source: 'package',
    readOnly: true,
    disableModelInvocation: true,
  });
  assert.equal(skills[1].source, 'managed');
  assert.equal(skills[1].readOnly, false);
  assert.equal(skills[2].enabled, false);
  const removed = await buildSkillCatalog({
    ...f.options,
    loadSkills: f.loadSkills,
    includeRemoved: true,
  });
  assert.equal(removed.skills.find((s) => s.name === 'removed').removed, true);
});

test('member and core-only catalogs never discover owner packages or implicit default skills', async (t) => {
  const f = await fixture(t);
  for (const mode of [{ owner: false }, { owner: true, coreOnly: true }]) {
    const catalog = await buildSkillCatalog({
      ...f.options,
      ...mode,
      loadSkills(p) {
        assert.deepEqual(p.skillPaths, [join(f.root, 'review', 'SKILL.md')]);
        return f.loadSkills(p);
      },
    });
    assert.ok(!JSON.stringify(catalog).includes(f.native));
    assert.equal(catalog.skills[0].name, 'review');
    if (!mode.owner) assert.equal(catalog.skills.length, 1);
  }
});

test('native loader priority and diagnostics win over a same-name managed definition', async (t) => {
  const f = await fixture(t);
  f.managed.push({ name: 'mermaid', description: 'Managed duplicate', enabled: true });
  await mkdir(join(f.root, 'mermaid'));
  await writeFile(join(f.root, 'mermaid', 'SKILL.md'), 'duplicate');
  const diagnostic = {
    type: 'collision',
    message: 'name "mermaid" collision',
    path: join(f.root, 'mermaid', 'SKILL.md'),
  };
  const catalog = await buildSkillCatalog({
    ...f.options,
    loadSkills(p) {
      assert.equal(p.skillPaths[0], f.native);
      assert.equal(p.skillPaths.at(-1), diagnostic.path);
      return {
        skills: [{ name: 'mermaid', description: 'Draw diagrams', filePath: f.native }],
        diagnostics: [diagnostic],
      };
    },
  });
  assert.equal(catalog.skills.filter((s) => s.name === 'mermaid').length, 1);
  assert.equal(catalog.skills.find((s) => s.name === 'mermaid').source, 'package');
  assert.ok(catalog.diagnostics.some((d) => d.type === 'collision'));
});

test('missing or invalid metadata is reported without advertising an enabled skill', async (t) => {
  const f = await fixture(t);
  const result = await buildSkillCatalog({
    ...f.options,
    loadSkills: () => ({
      skills: [],
      diagnostics: [{ type: 'warning', message: 'description is required', path: f.native }],
    }),
  });
  assert.ok(!result.skills.some((s) => s.source === 'package'));
  assert.ok(result.diagnostics.some((d) => d.message === 'description is required'));
  assert.equal(result.skills.find((s) => s.name === 'review').enabled, false);
  assert.equal(result.skills.find((s) => s.name === 'review').unavailable, true);
});

test('package Markdown reads preserve canonical boundaries, reject escapes and oversize files', async (t) => {
  const f = await fixture(t);
  const outside = join(f.dir, 'outside.md');
  await writeFile(outside, 'not authorized');
  const link = join(f.dir, 'package', 'mermaid', 'escape.md');
  await symlink(outside, link);
  assert.equal((await packageSkillLocation(f.native, [f.native])).path, f.native);
  assert.equal(await packageSkillLocation(link, [f.native]), null);
  assert.equal(
    await packageSkillLocation(join(f.dir, 'package', 'mermaid', '..', '..', 'outside.md'), [
      f.native,
    ]),
    null,
  );
  await writeFile(join(f.dir, 'package', 'mermaid', 'big.md'), 'x'.repeat(65537));
  await assert.rejects(
    packageSkillLocation(join(f.dir, 'package', 'mermaid', 'big.md'), [f.native]),
    /过大/,
  );
  const catalog = await buildSkillCatalog({
    ...f.options,
    loadSkills: () => ({
      skills: [{ name: 'escape', description: 'outside', filePath: link }],
      diagnostics: [],
    }),
  });
  assert.ok(!catalog.skills.some((s) => s.name === 'escape'));
  assert.ok(catalog.diagnostics.some((d) => d.type === 'warning'));
});

test('a managed symlink or traversing index entry cannot become a catalog read path', async (t) => {
  const f = await fixture(t);
  f.managed.push({ name: 'linked', description: 'Linked', enabled: true });
  f.managed.push({ name: '../outside', description: 'Traversal', enabled: true });
  await symlink(join(f.dir, 'package', 'mermaid'), join(f.root, 'linked'));
  const catalog = await buildSkillCatalog({
    ...f.options,
    loadSkills(p) {
      assert.ok(!p.skillPaths.some((path) => path.includes('linked') || path.includes('../')));
      return f.loadSkills(p);
    },
  });
  assert.equal(catalog.skills.find((s) => s.name === 'linked').unavailable, true);
  assert.ok(!catalog.skills.some((s) => s.name === '../outside'));
  assert.ok(catalog.diagnostics.some((d) => d.path.includes('linked')));
});
