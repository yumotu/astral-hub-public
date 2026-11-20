import { z } from 'zod';
const name = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .refine((value) => !/[\/\\\x00-\x1f]/.test(value));
const exportSchema = z
  .array(
    z.union([
      z.object({ name, content: z.string().max(262144) }).strict(),
      z
        .object({
          name,
          encoding: z.literal('base64'),
          data: z
            .string()
            .max(2796204)
            .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
        })
        .strict(),
    ]),
  )
  .max(8);
export function decodeExportFiles(exports = []) {
  const files = exportSchema
    .parse(exports)
    .map((file) => ({
      name: file.name,
      bytes: 'data' in file ? Buffer.from(file.data, 'base64') : Buffer.from(file.content),
    }));
  if (files.reduce((size, file) => size + file.bytes.length, 0) > 2 * 1024 * 1024)
    throw new Error('本轮生成文件总大小超过2 MiB，请分轮导出。');
  return files;
}
