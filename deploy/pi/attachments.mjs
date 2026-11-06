import { lstat, readFile, realpath } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { attachmentMaxBytes } from './attachment-limits.mjs';
export async function readAttachment(file) {
  const root = resolve(process.env.ASTRAL_UPLOADS_ROOT || '/uploads'),
    path = resolve(file.path);
  const rel = relative(root, path);
  if (!/^[a-f0-9]{64}\/[a-f0-9-]{36}\/[a-f0-9-]{36}$/.test(rel))
    throw new Error('附件路径不正确。');
  const [st, actual] = await Promise.all([lstat(path), realpath(path)]);
  if (!st.isFile() || st.isSymbolicLink() || actual !== path || st.size > attachmentMaxBytes)
    throw new Error('附件类型或大小不受支持。');
  const bytes = await readFile(path);
  if (createHash('sha256').update(bytes).digest('hex') !== file.sha256)
    throw new Error('附件已变化，请重新上传。');
  return bytes;
}
export function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString())) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP')
    return 'image/webp';
  return null;
}
