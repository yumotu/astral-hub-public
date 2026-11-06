import { Type } from 'typebox';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { loadConfig } from './config.mjs';
import { grantFiles, currentGrant } from './project-adapter.mjs';

function fileId(job, call) {
  const bytes = createHash('sha256')
    .update(job + ':' + call)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const h = bytes.toString('hex');
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20)].join('-');
}
export default function (pi) {
  pi.registerTool({
    name: 'chat_export',
    label: '发送电脑文件',
    description:
      '将已授权项目中的真实文件发送到当前聊天。支持图片预览、PDF/Office/压缩包下载，原始字节直接交付，不返回base64。只读项目也可发送已有文件，无需命令权限。path使用项目相对路径；content仅生成纯文本附件，不能用文本伪造PDF/Office/图片。单文件10 MiB，每任务8个、合计20 MiB。只有服务器确认后才报告已发送。',
    parameters: Type.Object(
      {
        path: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
        name: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
        content: Type.Optional(Type.String({ maxLength: 1048576 })),
      },
      { additionalProperties: false },
    ),
    async execute(call, p, signal) {
      if (signal?.aborted) throw Error('文件发送已取消。');
      if ((p.path !== undefined) === (p.content !== undefined))
        throw Error('请只提供path或content中的一种。');
      const { files } = await grantFiles();
      const name = p.name || (p.path ? basename(p.path) : 'result.txt');
      if (!name.trim() || name !== name.trim() || name.length > 160 || /[\/\\\x00-\x1f]/.test(name))
        throw Error('附件文件名不正确。');
      if (
        p.content !== undefined &&
        /\.(?:pdf|docx?|xlsx?|pptx?|png|jpe?g|gif|webp|zip|mp[34])$/i.test(name)
      )
        throw Error('此格式需要真实二进制文件，请先生成文件，再使用path发送。');
      const bytes = p.path
        ? await files.exportFile('device', p.path, { maxBytes: 10 * 1024 * 1024 })
        : Buffer.from(p.content, 'utf8');
      await currentGrant();
      const config = await loadConfig(process.env.ASTRAL_DEVICE_CONFIG),
        job = process.env.ASTRAL_DEVICE_JOB;
      if (!/^[0-9a-f-]{36}$/i.test(job || '')) throw Error('没有当前电脑任务，无法发送文件。');
      const id = fileId(job, call),
        sha256 = createHash('sha256').update(bytes).digest('hex');
      const url = config.server + '/api/relay/device/workspace/jobs/' + job + '/files/' + id;
      const combined = () =>
        AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60000)]);
      const headers = { Authorization: 'Bearer ' + config.token };
      const verify = (file) => {
        if (
          !file ||
          file.id !== id ||
          file.name !== name ||
          file.bytes !== bytes.length ||
          file.sha256 !== sha256
        )
          throw Error('服务器文件回执校验失败，请核对聊天附件，未重复发送。');
        return {
          content: [{ type: 'text', text: JSON.stringify({ sent: true, file }) }],
          details: { summary: '文件已发送到聊天', sha256, bytes: bytes.length, file },
        };
      };
      let failure;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (signal?.aborted) throw Error('文件发送已取消。');
        await currentGrant();
        try {
          const response = await fetch(url, {
            method: 'PUT',
            headers: {
              ...headers,
              'Content-Type': 'application/octet-stream',
              'X-Astral-File-Name': encodeURIComponent(name),
            },
            body: bytes,
            redirect: 'error',
            signal: combined(),
          });
          const result = await response.json();
          if (response.ok) return verify(result.file);
          const error = Error(result.error || '电脑文件发送失败。');
          if (response.status !== 429) throw Object.assign(error, { definitive: true });
          failure = error;
        } catch (e) {
          if (e.definitive || signal?.aborted) throw e;
          failure = e;
          // A lost acknowledgement never creates another file. Query the same
          // immutable ID before retrying the identical upload.
          try {
            const receipt = await fetch(url, { headers, redirect: 'error', signal: combined() });
            const result = await receipt.json();
            if (receipt.ok) return verify(result.file);
            if (receipt.status !== 404)
              throw Object.assign(Error(result.error || '交付确认失败。'), { definitive: true });
          } catch (e) {
            if (e.definitive) throw e;
          }
        }
        if (attempt < 2) await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
      }
      throw Error('文件交付未确认，请检查聊天附件后再操作：' + (failure?.message || '连接中断'));
    },
  });
}
