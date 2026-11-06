import { realpath, stat, lstat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

// The catalog and read tool share this boundary. A package may explicitly name a
// file or directory; following a child symlink must not grant access outside it.
export async function packageSkillLocation(path, roots) {
  const target = await realpath(path).catch(() => null);
  if (!target?.endsWith('.md')) return null;
  for (const path of roots) {
    const canonical = await realpath(path).catch(() => null);
    if (!canonical) continue;
    const info = await stat(canonical).catch(() => null);
    if (!info) continue;
    const root = info.isFile() ? dirname(canonical) : canonical;
    const rel = relative(root, target);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
    const file = await stat(target);
    if (!file.isFile() || file.size > 65536) throw new Error('技能资料过大或类型不支持。');
    return { path: target, root };
  }
  return null;
}

// Pass Pi's fixed loadSkills implementation, rather than reimplementing YAML,
// discovery or collision priority. These paths have the same order as RPC args.
export async function buildSkillCatalog({
  root,
  managed,
  packagePaths = [],
  owner = false,
  coreOnly = false,
  includeRemoved = false,
  cwd,
  agentDir,
  loadSkills,
}) {
  const native = owner && !coreOnly ? packagePaths : [];
  const definitions = managed.filter(
    (s) =>
      typeof s.name === 'string' &&
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s.name) &&
      s.name.length <= 64,
  );
  const enabled = definitions.filter((s) => s.enabled && !s.archived);
  const diagnostics = [],
    paths = [],
    managedByPath = new Map();
  for (const item of enabled) {
    const path = join(root, item.name, 'SKILL.md');
    try {
      const folder = await lstat(dirname(path)),
        file = await lstat(path);
      if (
        !folder.isDirectory() ||
        folder.isSymbolicLink() ||
        !file.isFile() ||
        file.isSymbolicLink() ||
        file.size > 65536
      )
        throw new Error('技能文件或目录不正确。');
      managedByPath.set(await realpath(path), item);
      paths.push(path);
    } catch (e) {
      diagnostics.push({ type: 'warning', message: e.message, path });
    }
  }
  const result = loadSkills({
    cwd,
    agentDir,
    includeDefaults: false,
    skillPaths: [...native, ...paths],
  });
  diagnostics.push(...result.diagnostics);
  const skills = [],
    names = new Set();
  for (const skill of result.skills) {
    try {
      const canonical = await realpath(skill.filePath);
      const item = managedByPath.get(canonical);
      const location = await packageSkillLocation(skill.filePath, native);
      if (!location && !item) throw new Error('技能路径超出当前已授权目录。');
      skills.push({
        name: skill.name,
        description: skill.description,
        path: canonical,
        enabled: true,
        source: location ? 'package' : 'managed',
        readOnly: !!location,
        ...(skill.disableModelInvocation ? { disableModelInvocation: true } : {}),
      });
      names.add(skill.name);
    } catch (e) {
      diagnostics.push({ type: 'warning', message: e.message, path: skill.filePath });
    }
  }
  // Keep owner management metadata for disabled/removed/missing managed skills,
  // but never offer a missing definition as an executable /skill choice.
  if (owner)
    for (const item of definitions) {
      if (names.has(item.name) || (item.archived && !includeRemoved)) continue;
      skills.push({
        name: item.name,
        description: item.description,
        path: join(root, item.name, 'SKILL.md'),
        enabled: false,
        source: 'managed',
        readOnly: false,
        removed: !!item.archived,
        ...(item.enabled && !item.archived ? { unavailable: true } : {}),
      });
    }
  return { skills, diagnostics };
}
