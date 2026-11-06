import { readFile, lstat, realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { z } from 'zod';
import { updateManifestSchema } from '../shared/app-updates.mjs';
import { fail } from './accounts.mjs';
export function createAppUpdates({ root, now = Date.now }) {
  root = resolve(root);
  const tickets = new Map(),
    verified = new Map();
  async function manifest() {
    try {
      return updateManifestSchema.parse(
        JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')),
      );
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw fail(503, '服务器更新清单不可用，请稍后重试。');
    }
  }
  async function asset(version, platform) {
    const current = await manifest();
    const item =
      current?.version === version && current.assets.find((a) => a.platform === platform);
    if (!item) throw fail(404, '该版本或平台的安装包尚未准备完成。');
    const path = join(root, version, item.name),
      info = await lstat(path);
    const actual = await realpath(path),
      base = await realpath(root);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size !== item.bytes ||
      !actual.startsWith(base + sep)
    )
      throw fail(409, '更新文件已变化，暂时无法下载。');
    const fingerprint = `${item.sha256}:${info.size}:${info.mtimeMs}`;
    if (verified.get(actual) !== fingerprint) {
      const hash = createHash('sha256');
      for await (const bytes of createReadStream(actual)) hash.update(bytes);
      if (hash.digest('hex') !== item.sha256) throw fail(409, '更新文件校验失败，已阻止下载。');
      if (verified.size > 20) verified.clear();
      verified.set(actual, fingerprint);
    }
    return { item, path: actual };
  }
  async function download(res, req, version, platform) {
    const { item, path } = await asset(version, platform);
    let start = 0,
      end = item.bytes - 1;
    if (req.headers.range) {
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
      if (
        !range ||
        Number(range[1]) >= item.bytes ||
        (range[2] && Number(range[2]) < Number(range[1]))
      )
        throw fail(416, '下载范围不正确。');
      start = Number(range[1]);
      if (range[2]) end = Math.min(end, Number(range[2]));
    }
    res.writeHead(req.headers.range ? 206 : 200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': end - start + 1,
      'Content-Disposition': `attachment; filename="${item.name}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Accept-Ranges': 'bytes',
      ETag: `"${item.sha256}"`,
      ...(req.headers.range ? { 'Content-Range': `bytes ${start}-${end}/${item.bytes}` } : {}),
    });
    const stream = createReadStream(path, { start, end });
    res.on('close', () => stream.destroy());
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }
  return {
    manifest,
    async before(req, url, res) {
      const match = url.pathname.match(/^\/api\/updates\/download\/([a-f0-9]{64})$/);
      if (!match) return false;
      const ticket = tickets.get(match[1]);
      if (req.method !== 'GET' || !ticket || ticket.expires <= now())
        throw fail(403, '下载链接已过期，请在软件内重新点击下载。');
      await download(res, req, ticket.version, ticket.platform);
      return true;
    },
    async handle(req, url, res, json, actor, body) {
      if (!url.pathname.startsWith('/api/updates')) return false;
      if (!actor?.id) throw fail(401, '请先登录后检查更新。');
      if (url.pathname === '/api/updates' && req.method === 'GET') {
        json(200, { release: await manifest() });
        return true;
      }
      if (url.pathname === '/api/updates/ticket' && req.method === 'POST') {
        const p = z
          .object({
            version: z.string().regex(/^\d+\.\d+\.\d+$/),
            platform: z.enum(['mac-arm64', 'mac-x64', 'win-x64', 'android']),
          })
          .strict()
          .parse(await body(req));
        const { item } = await asset(p.version, p.platform);
        for (const [k, v] of tickets) if (v.expires <= now()) tickets.delete(k);
        if (tickets.size > 200) throw fail(429, '下载请求较多，请稍后重试。');
        const ticket = randomBytes(32).toString('hex');
        tickets.set(ticket, { ...p, expires: now() + 5 * 60000 });
        json(200, { path: '/api/updates/download/' + ticket, asset: item });
        return true;
      }
      throw fail(404, '更新接口不存在。');
    },
  };
}
