import { readFile, readdir, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = process.cwd(),
  output = resolve(root, 'web/public/licenses');
await mkdir(output, { recursive: true });
await copyFile(resolve(root, 'LICENSE'), join(output, 'astral-hub-LICENSE.txt'));
const lock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8')),
  records = [];
for (const [path, meta] of Object.entries(lock.packages || {})) {
  if (!path || meta.dev || !path.startsWith('node_modules/')) continue;
  const dir = resolve(root, path),
    name = meta.name || path.split('node_modules/').at(-1);
  let files;
  try {
    files = await readdir(dir);
  } catch (e) {
    if (e.code === 'ENOENT' && meta.optional) continue;
    throw e;
  }
  const notices = [];
  for (const file of files
    .filter((v) => /^(licen[sc]e|copying|notice)([.-].*)?$/i.test(v))
    .sort()) {
    try {
      notices.push({ file, text: await readFile(join(dir, file), 'utf8') });
    } catch (e) {
      if (e.code !== 'EISDIR') throw e;
    }
  }
  records.push({
    name,
    version: meta.version,
    license: meta.license || 'See package license',
    notices,
  });
}
records.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
await writeFile(join(output, 'dependencies.json'), JSON.stringify(records, null, 2) + '\n');
await writeFile(
  join(output, 'dependencies.txt'),
  records
    .map(
      (p) =>
        `${p.name}@${p.version}\nDeclared license: ${p.license}\n` +
        p.notices.map((n) => `${n.file}\n${n.text}`).join('\n'),
    )
    .join('\n\n------------------------------------------------------------\n\n') + '\n',
);
console.log(`Prepared license notices for ${records.length} production dependencies`);
