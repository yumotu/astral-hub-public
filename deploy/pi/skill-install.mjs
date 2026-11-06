import { posix } from 'node:path';
const fail = (status, message) => Object.assign(new Error(message), { status });
// ProjectFiles applies the same folder grants and protected-path checks used by file tools.
export function createSkillInstaller({ files, store, parseFrontmatter }) {
  return async function install(projectId, path = 'skills', signal) {
    await files.directory(projectId, path);
    const root = await files.list(projectId, path);
    if (root.truncated) throw fail(413, '技能目录条目过多，请指定单个技能目录。');
    const candidates = [];
    if (root.entries.some((e) => e.name === 'SKILL.md' && e.type === 'file')) candidates.push(path);
    else
      for (const entry of root.entries.filter((e) => e.type === 'directory')) {
        const list = await files.list(projectId, entry.path);
        if (list.truncated) throw fail(413, '技能目录条目过多，请指定单个技能目录。');
        if (list.entries.some((e) => e.name === 'SKILL.md' && e.type === 'file'))
          candidates.push(entry.path);
      }
    if (!candidates.length)
      throw fail(400, '没有找到 SKILL.md；请指定技能目录或含技能子目录的目录。');
    const installed = [],
      skipped = [],
      errors = [];
    for (const folder of candidates) {
      if (signal?.aborted) throw fail(400, '操作已取消');
      try {
        const source = await files.readResource(projectId, posix.join(folder, 'SKILL.md'));
        const markdown = new TextDecoder('utf-8', { fatal: true }).decode(source.data);
        if (!/^\uFEFF?---\r?\n/.test(markdown)) throw fail(400, 'SKILL.md 缺少 YAML frontmatter。');
        const { frontmatter, body } = parseFrontmatter(markdown);
        const name = frontmatter.name,
          description = frontmatter.description;
        if (
          typeof name !== 'string' ||
          !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ||
          name.length > 64 ||
          typeof description !== 'string' ||
          !description.trim()
        )
          throw fail(400, 'frontmatter 必须包含合法 name 和非空 description。');
        if ((await store.list()).some((s) => s.name === name)) {
          skipped.push({ name, reason: '同名技能已存在，未覆盖；可在聊天中要求启用、恢复或修改。' });
          continue;
        }
        const resources = [];
        let bytes = 0;
        async function walk(dir, depth = 0) {
          if (depth > 12) throw fail(413, '技能资源目录层级过深。');
          const list = await files.list(projectId, dir);
          if (list.truncated) throw fail(413, '技能资源文件过多。');
          for (const e of list.entries) {
            if (signal?.aborted) throw fail(400, '操作已取消');
            if (e.type === 'directory') await walk(e.path, depth + 1);
            else if (e.path !== posix.join(folder, 'SKILL.md')) {
              const value = await files.readResource(projectId, e.path);
              bytes += value.data.length;
              if (resources.length >= 100 || bytes > 4 * 1024 * 1024)
                throw fail(413, '单个技能最多100个附带文件、合计4 MiB。');
              resources.push({ path: posix.relative(folder, e.path), ...value });
            }
          }
        }
        await walk(folder);
        installed.push(
          await store.save(
            { name, description, instructions: body, enabled: true },
            { createOnly: true, markdown, resources, frontmatter },
          ),
        );
      } catch (e) {
        errors.push({
          path: folder,
          error: e.status ? e.message : '技能文件解析或导入失败，请检查格式和文件权限。',
        });
      }
    }
    return { installed, skipped, errors };
  };
}
