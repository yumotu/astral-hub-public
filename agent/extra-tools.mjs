import { Type } from 'typebox';
import { cpus, totalmem, freemem, release } from 'node:os';
import { grantFiles } from './project-adapter.mjs';
const path = Type.String({ minLength: 1, maxLength: 500, description: '已授权项目内相对路径' });
const object = (fields) => Type.Object(fields, { additionalProperties: false });
export const extraToolNames = [
  'computer_info',
  'project_stat',
  'project_tree',
  'project_read_many',
];
export const extraWriteToolNames = ['project_mkdir', 'project_diff', 'project_restore'];
export default function (pi) {
  const register = (name, label, description, parameters, run) =>
    pi.registerTool({
      name,
      label,
      description,
      parameters,
      async execute(_id, p, signal) {
        if (signal?.aborted) throw Error('操作已取消。');
        const { grant, files } = await grantFiles();
        const result = await run(files, p, grant, signal);
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          details: { summary: label + '完成' },
        };
      },
    });
  register(
    'computer_info',
    '电脑环境',
    '检查当前电脑的系统、Node版本、CPU数量、内存与本项目授权。不会读取环境变量、凭据或未授权目录。',
    object({}),
    (_f, _p, grant) => ({
      platform: process.platform,
      arch: process.arch,
      osRelease: release(),
      node: process.version,
      cpuCount: cpus().length,
      memory: { totalBytes: totalmem(), freeBytes: freemem() },
      project: {
        name: grant.name,
        readOnly: process.env.ASTRAL_PROJECT_ACCESS !== 'edit' || !grant.allowWrite,
        allowExecute: process.env.ASTRAL_DEVICE_EXECUTE === '1' && !!grant.allowExecute,
      },
    }),
  );
  register(
    'project_stat',
    '文件信息',
    '检查项目中文件或目录的类型、字节大小与修改时间。保留敏感路径和链接保护。',
    object({ path }),
    (f, p) => f.info('device', p.path),
  );
  register(
    'project_tree',
    '项目目录树',
    '浏览已授权项目的目录树，最多3层、200项；不跟随链接，不包含私有目录。结果会明确标记截断。',
    object({
      path: Type.Optional(path),
      depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
    }),
    async (f, p, _g, signal) => {
      const entries = [];
      let truncated = false;
      async function walk(at, depth) {
        if (signal?.aborted) throw Error('操作已取消。');
        const result = await f.list('device', at);
        truncated ||= !!result.truncated;
        for (const item of result.entries) {
          if (entries.length >= 200) {
            truncated = true;
            return;
          }
          const itemPath = at === '.' ? item.name : at + '/' + item.name;
          entries.push({ ...item, path: itemPath });
          if (item.type === 'directory' && depth > 1) await walk(itemPath, depth - 1);
        }
      }
      await walk(p.path || '.', p.depth || 2);
      return { entries, truncated };
    },
  );
  register(
    'project_read_many',
    '批量读取',
    '一次读取最多8个项目文本文件，每文件最多100行，总文本最多32000字；返回哈希并明确标记错误或截断。',
    object({ paths: Type.Array(path, { minItems: 1, maxItems: 8 }) }),
    async (f, p, _g, signal) => {
      let remaining = 32000;
      const files = [];
      for (const path of p.paths) {
        if (signal?.aborted) throw Error('操作已取消。');
        if (!remaining) {
          files.push({ path, error: '批量文本预算已用完，请单独读取。' });
          continue;
        }
        try {
          const result = await f.read('device', path, 1, 100);
          const content = result.content.slice(0, remaining);
          remaining -= content.length;
          files.push({
            ...result,
            content,
            truncated: result.truncated || content.length !== result.content.length,
          });
        } catch (e) {
          files.push({ path, error: e.message });
        }
      }
      return { files };
    },
  );
  if (process.env.ASTRAL_PROJECT_ACCESS === 'edit') {
    register(
      'project_mkdir',
      '新建目录',
      '在可修改项目中新建一层目录，不覆盖已有路径。',
      object({ path }),
      (f, p) => f.mkdir('device', p.path),
    );
    register(
      'project_diff',
      '查看修改',
      '查看当前项目中指定备份对应的真实差异。',
      object({ backupId: Type.String({ format: 'uuid' }) }),
      (f, p) => f.diff('device', p.backupId),
    );
    register(
      'project_restore',
      '恢复修改',
      '恢复本项目的指定备份，仅当文件未再次变化时执行；不会覆盖后续修改。',
      object({ backupId: Type.String({ format: 'uuid' }) }),
      (f, p) => f.restore('device', p.backupId),
    );
  }
}
