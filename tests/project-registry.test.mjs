import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProjects } from '../deploy/pi/projects.mjs';
import { createProjectFiles } from '../deploy/pi/project-files.mjs';
test('folder projects narrow file access; explicit grants persist, enforce modes and revoke', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'astral-project-registry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'a'));
  await mkdir(join(dir, 'b'));
  await writeFile(join(dir, 'a', 'note.txt'), 'A');
  await writeFile(join(dir, 'b', 'note.txt'), 'B');
  await symlink(join(dir, 'b'), join(dir, 'link'));
  const options = {
    sources: [
      { id: 'root', name: 'Root', root: dir, serverPath: dir, readOnly: false },
      {
        id: 'readonly',
        name: 'Read only',
        root: join(dir, 'b'),
        serverPath: join(dir, 'b'),
        readOnly: true,
      },
    ],
    registryFile: join(dir, 'registry.json'),
    backupDir: join(dir, 'backups'),
  };
  let registry = await createProjects(options);
  const [a, b] = await Promise.all([
    registry.create({ name: 'Alpha', sourceId: 'root', path: 'a' }),
    registry.create({ name: 'Beta', sourceId: 'root', path: 'b' }),
  ]);
  assert.equal(registry.files.projects().filter((p) => !p.source).length, 2);
  await assert.rejects(
    registry.create({ name: 'Escape', sourceId: 'root', path: '../' }),
    (e) => e.status === 403,
  );
  await assert.rejects(
    registry.create({ name: 'Link', sourceId: 'root', path: 'link' }),
    (e) => e.status === 403,
  );
  let scoped = createProjectFiles({
    projects: registry.scope(a.id, 'read'),
    backupDir: options.backupDir,
  });
  assert.equal((await scoped.read(a.id, 'note.txt')).content, 'A');
  await assert.rejects(scoped.read(a.id, '../b/note.txt'), (e) => e.status === 403);
  await assert.rejects(scoped.read(b.id, 'note.txt'), (e) => e.status === 404);
  await registry.grants(a.id, [{ projectId: b.id, access: 'read' }]);
  registry = await createProjects(options);
  scoped = createProjectFiles({
    projects: registry.scope(a.id, 'edit'),
    backupDir: options.backupDir,
  });
  assert.equal((await scoped.read(b.id, 'note.txt')).content, 'B');
  await assert.rejects(scoped.write(b.id, 'new.txt', 'no', 'new', 'edit'), (e) => e.status === 403);
  await assert.rejects(
    registry.grants(a.id, [{ projectId: 'readonly', access: 'edit' }]),
    (e) => e.status === 403,
  );
  await registry.grants(a.id, []);
  assert.equal(registry.scope(a.id).length, 1);
});

test('full project access exposes other projects while preserving read mode and saved settings', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'astral-full-projects-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'a'));
  await mkdir(join(dir, 'b'));
  await writeFile(join(dir, 'b', 'note.txt'), 'B');
  const options = { sources: [{ id: 'root', name: 'Root', root: dir, serverPath: dir, readOnly: false }], registryFile: join(dir, 'registry.json'), backupDir: join(dir, 'backups') };
  let registry = await createProjects(options);
  const a = await registry.create({ name: 'A', sourceId: 'root', path: 'a' });
  const b = await registry.create({ name: 'B', sourceId: 'root', path: 'b' });
  registry = await createProjects({ ...options, fullAccess: true });
  const edit = createProjectFiles({ projects: registry.scope(a.id, 'edit'), backupDir: options.backupDir });
  assert.equal((await edit.read(b.id, 'note.txt')).content, 'B');
  await edit.write(b.id, 'new.txt', 'created', 'new', 'edit');
  const read = createProjectFiles({ projects: registry.scope(a.id, 'read'), backupDir: options.backupDir });
  await assert.rejects(read.write(b.id, 'denied.txt', 'x', 'new', 'edit'), (e) => e.status === 403);
  registry = await createProjects(options);
  assert.equal(registry.scope(a.id).length, 1);
});
