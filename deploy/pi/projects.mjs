import { readFile, writeFile, rename, mkdir, lstat, realpath, rmdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve, relative } from 'node:path';
import { createProjectFiles } from './project-files.mjs';
const fail = (status, message) => Object.assign(new Error(message), { status });
export async function createProjects({ sources, registryFile, backupDir, fullAccess = false }) {
  let saved = [];
  let sourceGrants = {};
  try {
    saved = JSON.parse(await readFile(registryFile, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  try {
    sourceGrants = JSON.parse(await readFile(registryFile + '.members.json', 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const originals = await Promise.all(
    sources.map(async (p) => ({
      ...p,
      source: true,
      canonicalRoot: await realpath(p.root),
      memberGrants: sourceGrants[p.id] || [],
    })),
  );
  const publicProject = ({ root, canonicalRoot, ...p }) => p;
  const validatePrincipal = (p) => {
    if (
      !p ||
      !/^[a-f0-9-]{36}$/.test(p.id) ||
      !/^[a-z0-9][a-z0-9_-]{2,31}$/.test(p.username) ||
      typeof p.admin !== 'boolean'
    )
      throw fail(403, '项目账号信息不正确。');
    return p;
  };
  const permission = (project, principal) => {
    if (!principal || principal.admin || project.ownerId === principal.id)
      return project.readOnly ? 'read' : 'edit';
    return project.memberGrants?.find((g) => g.userId === principal.id)?.access || null;
  };
  let files;
  const refresh = () => {
    const all = [...originals, ...saved];
    const enriched = all.map((p) => {
      const source = all.find((s) => s.id === p.sourceId);
      const canonicalRoot =
        p.canonicalRoot ||
        (source
          ? resolve(source.canonicalRoot || source.root, relative(source.root, p.root))
          : p.root);
      return { ...p, canonicalRoot, ...(fullAccess && !p.source ? { readOnly: false } : {}) };
    });
    files = createProjectFiles({ projects: enriched, backupDir });
  };
  refresh();
  let pending = Promise.resolve();
  function update(fn) {
    const result = pending.then(fn);
    pending = result.catch(() => {});
    return result;
  }
  async function persist(next) {
    const temp = registryFile + '.' + randomUUID() + '.tmp';
    await writeFile(temp, JSON.stringify(next), { mode: 0o600 });
    await rename(temp, registryFile);
    saved = next;
    refresh();
  }
  return {
    get files() {
      return files;
    },
    async ensureUser(principal) {
      validatePrincipal(principal);
      if (principal.admin) return null;
      return update(async () => {
        const source = originals.find((p) => p.id === 'workspace' && !p.readOnly);
        if (!source) throw fail(503, '尚未配置可写的用户项目目录。');
        if ((await realpath(source.root)) !== source.canonicalRoot)
          throw fail(403, '用户项目根目录已变化。');
        const parent = join(source.canonicalRoot, 'users');
        await mkdir(parent, { mode: 0o750 }).catch((e) => {
          if (e.code !== 'EEXIST') throw e;
        });
        if ((await lstat(parent)).isSymbolicLink() || !(await lstat(parent)).isDirectory())
          throw fail(403, '用户目录必须是普通目录。');
        const root = join(parent, principal.username),
          existing = saved.find((p) => p.userRoot && p.ownerId === principal.id);
        if (existing) {
          if (
            existing.root !== root ||
            (await realpath(root)) !== root ||
            (await lstat(root)).isSymbolicLink()
          )
            throw fail(403, '用户名目录归属或实际路径已变化。');
          return publicProject(existing);
        }
        if (
          await lstat(root).catch((e) => {
            if (e.code === 'ENOENT') return null;
            throw e;
          })
        )
          throw fail(409, '此用户名目录已存在但尚未绑定账号，请管理员先确认归属。');
        await mkdir(root, { mode: 0o750 });
        const project = {
          id: 'user-' + principal.id,
          name: principal.username + ' 的文件',
          root,
          canonicalRoot: root,
          source: true,
          userRoot: true,
          ownerId: principal.id,
          username: principal.username,
          sourceId: source.id,
          serverPath: join(source.serverPath, 'users', principal.username),
          readOnly: false,
          description: '仅此账号默认可访问的用户名目录',
          grants: [],
          memberGrants: [],
        };
        try {
          await persist([...saved, project]);
        } catch (e) {
          await rmdir(root).catch(() => {});
          throw e;
        }
        return publicProject(project);
      });
    },
    async listFor(principal) {
      validatePrincipal(principal);
      await this.ensureUser(principal);
      return files
        .projects()
        .filter((p) => permission(p, principal))
        .map((p) => {
          const access = permission(p, principal),
            visible = { ...p, readOnly: p.readOnly || access !== 'edit', memberAccess: access };
          if (!principal.admin) {
            delete visible.memberGrants;
            visible.grants = (visible.grants || []).filter((g) => {
              try {
                return !!permission(files.project(g.projectId), principal);
              } catch {
                return false;
              }
            });
          }
          return visible;
        });
    },
    async create(p, principal) {
      return update(async () => {
        if (principal) validatePrincipal(principal);
        const source = files.project(p.sourceId);
        if (
          typeof p.name !== 'string' ||
          !p.name.trim() ||
          p.name.length > 60 ||
          !(source.source && (originals.some((x) => x.id === p.sourceId) || source.userRoot))
        )
          throw fail(400, '项目名称或来源目录不正确。');
        if (principal && !principal.admin && (!source.userRoot || source.ownerId !== principal.id))
          throw fail(403, '只能在自己的用户名目录中新建项目。');
        if (saved.length >= 2000) throw fail(400, '项目数量已达上限。');
        const root = await realpath(await files.directory(p.sourceId, p.path || '.'));
        if (saved.some((x) => !x.userRoot && x.root === root))
          throw fail(409, '这个文件夹已经建立项目。');
        const project = {
          id: randomUUID(),
          name: p.name.trim(),
          root,
          canonicalRoot: root,
          source: false,
          sourceId: p.sourceId,
          serverPath: join(source.serverPath, p.path || '.'),
          readOnly: source.readOnly,
          description: '项目文件夹及其子目录',
          grants: [],
          memberGrants: [],
          ...(source.ownerId ? { ownerId: source.ownerId, username: source.username } : {}),
        };
        await persist([...saved, project]);
        return publicProject(project);
      });
    },
    async grants(id, grants) {
      return update(async () => {
        const project = saved.find((p) => p.id === id);
        if (!project) throw fail(404, '仅可修改自己创建的项目授权。');
        if (
          !Array.isArray(grants) ||
          grants.length > 8 ||
          new Set(grants.map((g) => g.projectId)).size !== grants.length
        )
          throw fail(400, '授权列表不正确。');
        const next = grants.map((g) => {
          const target = files.project(g.projectId);
          if (
            target.id === id ||
            !['read', 'edit'].includes(g.access) ||
            (target.readOnly && g.access === 'edit')
          )
            throw fail(403, '目标文件夹不支持这项权限。');
          return { projectId: target.id, access: g.access };
        });
        await persist(saved.map((p) => (p.id === id ? { ...p, grants: next } : p)));
        return next;
      });
    },
    async members(id, member) {
      return update(async () => {
        const project = saved.find((p) => p.id === id) || originals.find((p) => p.id === id);
        if (!project) throw fail(404, '项目不存在。');
        if (
          !/^[a-f0-9-]{36}$/.test(member.userId) ||
          !/^[a-z0-9][a-z0-9_-]{2,31}$/.test(member.username) ||
          ![null, 'read', 'edit'].includes(member.access)
        )
          throw fail(400, '成员授权格式不正确。');
        if (project.readOnly && member.access === 'edit') throw fail(403, '只读目录不能授权修改。');
        const list = (project.memberGrants || []).filter((g) => g.userId !== member.userId);
        if (member.access) list.push(member);
        if (list.length > 100) throw fail(400, '此目录的成员授权数量已达上限。');
        if (project.source && !project.userRoot) {
          const next = { ...sourceGrants, [id]: list },
            temp = registryFile + '.members.' + randomUUID() + '.tmp';
          await writeFile(temp, JSON.stringify(next), { mode: 0o600 });
          await rename(temp, registryFile + '.members.json');
          sourceGrants = next;
          project.memberGrants = list;
          refresh();
        } else await persist(saved.map((p) => (p.id === id ? { ...p, memberGrants: list } : p)));
        return list;
      });
    },
    async authorize(principal, id, access = 'read') {
      if (principal) validatePrincipal(principal);
      const scoped = this.scope(id, access, principal),
        valid = [];
      for (const project of scoped) {
        try {
          if (
            (await lstat(project.root)).isSymbolicLink() ||
            (await realpath(project.root)) !== project.canonicalRoot
          )
            throw fail(403, '项目的实际目录已变化，请管理员核对。');
          valid.push(project);
        } catch (e) {
          if (project.id === id || !principal?.admin) throw e;
        }
      }
      return valid;
    },
    scope(id, access = 'read', principal) {
      if (!id) return [];
      const project = files.project(id);
      const allowed = permission(project, principal);
      if (!allowed || (access === 'edit' && allowed !== 'edit'))
        throw fail(403, '此账号尚未获准访问或修改这个目录。');
      if (project.readOnly && access === 'edit') throw fail(403, '项目文件夹为只读。');
      const entries =
        fullAccess && (!principal || principal.admin)
          ? [
              { projectId: id, access },
              ...[...originals, ...saved]
                .filter((p) => p.id !== id)
                .map((p) => ({ projectId: p.id, access })),
            ]
          : [
              { projectId: id, access },
              ...(project.grants || []).filter((g) => {
                try {
                  return !principal || !!permission(files.project(g.projectId), principal);
                } catch {
                  return false;
                }
              }),
            ];
      return entries.map((g) => {
        const p = files.project(g.projectId);
        const permitted = permission(p, principal),
          mode = access === 'edit' && g.access === 'edit' && permitted === 'edit' ? 'edit' : 'read';
        return { ...p, access: mode, readOnly: p.readOnly || mode !== 'edit' };
      });
    },
  };
}
