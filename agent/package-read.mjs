import { Type } from 'typebox';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { currentGrant, grantFiles } from './project-adapter.mjs';
// Pi's skill prompt uses `read` with absolute SKILL.md paths. This adapter reads
// package Markdown or the existing scoped project; it is not a new host reader.
export default function packageRead(pi) {
  const roots = JSON.parse(process.env.ASTRAL_PACKAGE_ROOTS || '[]');
  if (!roots.length || process.env.ASTRAL_DEVICE_EXECUTE !== '1') return;
  pi.registerTool({
    name: 'read',
    label: '读取插件说明',
    description:
      '读取已安装插件的Markdown说明，或当前授权项目的文本文件；运行脚本使用computer_exec。',
    parameters: Type.Object(
      {
        path: Type.String({ maxLength: 1000 }),
        offset: Type.Optional(Type.Integer({ minimum: 1 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
      },
      { additionalProperties: false },
    ),
    async execute(_id, args, signal) {
      const grant = await currentGrant();
      if (!grant.allowExecute || signal?.aborted) throw Error('本机已撤销插件执行权限。');
      const path = resolve(grant.root, args.path),
        inside = (root) => {
          const rel = relative(root, path);
          return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
        };
      let content;
      if (roots.some(inside) && /\.md$/i.test(path)) {
        const st = await lstat(path),
          actual = await realpath(path);
        if (
          !st.isFile() ||
          st.isSymbolicLink() ||
          st.nlink > 1 ||
          st.size > 262144 ||
          actual !== path
        )
          throw Error('插件说明文件异常。');
        content = await readFile(path, 'utf8');
      } else {
        const { files } = await grantFiles();
        const doc = await files.document('device', relative(grant.root, path));
        content = doc.content;
      }
      const lines = content.split('\n'),
        start = (args.offset || 1) - 1;
      return {
        content: [
          { type: 'text', text: lines.slice(start, start + (args.limit || 300)).join('\n') },
        ],
        details: { summary: '已读取说明/项目文本' },
      };
    },
  });
}
