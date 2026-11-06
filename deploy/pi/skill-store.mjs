import { readFile, writeFile, mkdir, lstat, rename, rm, realpath } from 'node:fs/promises';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
const fail = (status, message) => Object.assign(new Error(message), { status });
const revision = (item) => createHash('sha256').update(JSON.stringify(item)).digest('hex');
export function createSkillStore(root) {
  const file = join(dirname(root), 'skills.json');
  let pending = Promise.resolve();
  async function list() {
    try {
      const items = JSON.parse(await readFile(file, 'utf8'));
      if (!Array.isArray(items)) throw new Error();
      return items;
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw fail(503, '技能目录读取失败。');
    }
  }
  async function directory(path) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) throw fail(403, '技能目录不正确。');
  }
  function save(
    p,
    { createOnly = false, markdown, resources = [], frontmatter, expectedRevision, archived } = {},
  ) {
    const result = pending.then(async () => {
      if (
        !p ||
        typeof p.name !== 'string' ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(p.name) ||
        p.name.length > 64 ||
        typeof p.description !== 'string' ||
        !p.description.trim() ||
        p.description.length > 1024 ||
        typeof p.instructions !== 'string' ||
        !p.instructions.trim() ||
        p.instructions.length > 60000 ||
        typeof p.enabled !== 'boolean'
      )
        throw fail(400, '技能名称、用途或执行说明格式不正确。');
      const items = await list(),
        previous = items.find((s) => s.name === p.name);
      if (expectedRevision && (!previous || revision(previous) !== expectedRevision))
        throw fail(409, '技能已发生变化，请重新查看后再修改。');
      if (createOnly && previous)
        throw fail(409, '同名技能已存在，请使用其他名称；不会覆盖原技能。');
      if (!previous && items.length >= 50) throw fail(400, '最多保存50个技能。');
      if (resources.length > 100) throw fail(413, '单个技能最多100个附带文件。');
      const seen = new Set();
      let bytes = 0;
      for (const r of resources) {
        if (
          typeof r.path !== 'string' ||
          r.path === 'SKILL.md' ||
          r.path
            .split('/')
            .some(
              (n) => !n || n === '..' || n === '.' || (n.startsWith('.') && n !== '.gitignore'),
            ) ||
          isAbsolute(r.path) ||
          /[\\\x00-\x1f]/.test(r.path) ||
          seen.has(r.path) ||
          !Buffer.isBuffer(r.data) ||
          r.data.length > 262144
        )
          throw fail(400, '技能资源路径或内容不正确。');
        seen.add(r.path);
        bytes += r.data.length;
      }
      if (bytes > 4 * 1024 * 1024) throw fail(413, '技能资源合计最多4 MiB。');
      const extra = { ...(previous?.frontmatter || {}), ...(frontmatter || {}) };
      delete extra.name;
      delete extra.description;
      const item = {
        name: p.name,
        description: p.description.trim(),
        instructions: p.instructions,
        enabled: (archived ?? previous?.archived) ? false : p.enabled,
        ...((archived ?? previous?.archived) ? { archived: true } : {}),
        ...(resources.length
          ? { resources: resources.map((r) => r.path) }
          : previous?.resources
            ? { resources: previous.resources }
            : {}),
        ...(Object.keys(extra).length ? { frontmatter: extra } : {}),
      };
      const header = [
        `name: ${item.name}`,
        `description: ${JSON.stringify(item.description)}`,
        ...Object.entries(extra).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`),
      ].join('\n');
      const document = markdown ?? `---\n${header}\n---\n\n${item.instructions}`;
      if (typeof document !== 'string' || Buffer.byteLength(document) > 65536)
        throw fail(413, '技能定义最多64 KiB。');
      await directory(root);
      const folder = join(root, p.name),
        path = join(folder, 'SKILL.md');
      const info = await lstat(folder).catch((e) => {
        if (e.code !== 'ENOENT') throw e;
        return null;
      });
      if (info && (info.isSymbolicLink() || !info.isDirectory()))
        throw fail(403, '技能目录不正确。');
      if (createOnly && info) throw fail(409, '技能目录已存在，未覆盖。');
      const old = await lstat(path).catch((e) => {
        if (e.code !== 'ENOENT') throw e;
        return null;
      });
      if (old && (!old.isFile() || old.isSymbolicLink())) throw fail(403, '技能文件不正确。');
      const stage = !old ? join(root, '.skill-staging-' + randomUUID()) : null;
      if (stage) await directory(stage);
      const temp = stage ? join(stage, 'SKILL.md') : path + '.' + randomUUID() + '.tmp',
        indexTemp = file + '.' + randomUUID() + '.tmp';
      try {
        await writeFile(temp, document, { mode: 0o600, flag: 'wx' });
        for (const r of resources) {
          let parent = stage || folder;
          for (const part of r.path.split('/').slice(0, -1)) {
            parent = join(parent, part);
            await directory(parent);
          }
          await writeFile(join(stage || folder, r.path), r.data, {
            mode: 0o600 | (r.mode & 0o111),
            flag: 'wx',
          });
        }
        await writeFile(
          indexTemp,
          JSON.stringify([...items.filter((s) => s.name !== item.name), item]),
          { mode: 0o600, flag: 'wx' },
        );
        if (stage) await rename(stage, folder);
        else await rename(temp, path);
        await rename(indexTemp, file);
      } finally {
        if (stage) await rm(stage, { recursive: true, force: true });
        else await rm(temp, { force: true });
        await rm(indexTemp, { force: true });
      }
      return {
        name: item.name,
        description: item.description,
        enabled: item.enabled,
        path,
        command: `/skill:${item.name}`,
        resourceCount: item.resources?.length || 0,
        archived: !!item.archived,
        revision: revision(item),
      };
    });
    pending = result.catch(() => {});
    return result;
  }
  async function inspect(name) {
    if (typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64)
      throw fail(400, '技能名称不正确。');
    const item = (await list()).find((s) => s.name === name);
    if (!item) throw fail(404, '技能不存在。');
    const base = await realpath(root),
      folder = join(base, name),
      path = join(folder, 'SKILL.md');
    const info = await lstat(folder),
      document = await lstat(path);
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      document.isSymbolicLink() ||
      !document.isFile()
    )
      throw fail(403, '技能文件或目录不正确。');
    if (document.size > 65536) throw fail(413, '技能定义最多64 KiB。');
    return {
      ...item,
      archived: !!item.archived,
      revision: revision(item),
      path,
      markdown: await readFile(path, 'utf8'),
    };
  }
  async function manage({ name, action, revision: expectedRevision, description, instructions }) {
    const item = await inspect(name);
    if (action === 'inspect') {
      const { markdown, ...definition } = item;
      return definition;
    }
    if (!['update', 'enable', 'disable', 'remove', 'restore'].includes(action))
      throw fail(400, '不支持的技能操作。');
    if (!expectedRevision || expectedRevision !== item.revision)
      throw fail(409, '请先查看技能并使用当前 revision 修改，避免覆盖其他变更。');
    if (item.archived && !['remove', 'restore'].includes(action))
      throw fail(409, '技能已移除，请先恢复。');
    if (action === 'update' && description === undefined && instructions === undefined)
      throw fail(400, '请提供需要修改的用途或执行说明。');
    if (action !== 'update' && (description !== undefined || instructions !== undefined))
      throw fail(400, '仅 update 操作可修改技能内容。');
    return save(
      {
        name: item.name,
        description: description ?? item.description,
        instructions: instructions ?? item.instructions,
        enabled:
          action === 'enable'
            ? true
            : ['disable', 'remove', 'restore'].includes(action)
              ? false
              : item.enabled,
      },
      {
        expectedRevision,
        archived: action === 'remove' || (action !== 'restore' && item.archived),
        ...(action === 'update' ? {} : { markdown: item.markdown }),
      },
    );
  }
  async function mounts() {
    const base = await realpath(root),
      result = [];
    for (const s of (await list()).filter((s) => s.enabled)) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s.name)) throw fail(403, '技能目录名称不正确。');
      const path = join(base, s.name),
        info = await lstat(path);
      if (info.isSymbolicLink() || !info.isDirectory()) throw fail(403, '技能目录不允许链接。');
      result.push({ name: s.name, path });
    }
    return result;
  }
  async function read(path, offset = 1, limit = 400) {
    const base = await realpath(root);
    const given = resolve(path);
    const lexical = relative(resolve(root), given);
    const rel = !lexical.startsWith('..') && !isAbsolute(lexical) ? lexical : relative(base, given);
    const target = join(base, rel);
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || !target.endsWith('.md'))
      throw fail(403, '仅可读取已启用技能中的 Markdown 资料。');
    const parts = rel.split('/');
    if (!(await list()).some((s) => s.name === parts[0] && s.enabled))
      throw fail(403, '技能未启用或不存在。');
    let current = base;
    for (const part of parts) {
      current = join(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw fail(403, '技能资料不允许符号链接。');
    }
    const info = await lstat(target);
    if (!info.isFile() || info.size > 65536) throw fail(413, '技能资料过大或类型不支持。');
    return (await readFile(target, 'utf8'))
      .split('\n')
      .slice(offset - 1, offset - 1 + limit)
      .join('\n');
  }
  return { list, save, read, mounts, inspect, manage };
}
