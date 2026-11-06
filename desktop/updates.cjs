const { mkdir, rename, rm, lstat } = require('node:fs/promises');
const { createReadStream, createWriteStream } = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
function validateDownload(url, asset, platform) {
  const u = new URL(url);
  if (
    (u.protocol !== 'https:' &&
      !(u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))) ||
    u.username ||
    u.password ||
    !/^\/api\/updates\/download\/[a-f0-9]{64}$/.test(u.pathname) ||
    u.search ||
    u.hash
  )
    throw new Error('更新下载地址不正确。');
  const suffix = {
    'mac-arm64': 'mac-arm64.dmg',
    'mac-x64': 'mac-x64.dmg',
    'win-x64': 'win-x64.exe',
  }[platform];
  if (
    !suffix ||
    asset.platform !== platform ||
    !new RegExp('^Astral-Hub-\\d+\\.\\d+\\.\\d+-' + suffix.replaceAll('.', '\\.') + '$').test(
      asset.name,
    ) ||
    !/^[a-f0-9]{64}$/.test(asset.sha256) ||
    !Number.isSafeInteger(asset.bytes) ||
    asset.bytes <= 0 ||
    asset.bytes > 512 * 1024 ** 2
  )
    throw new Error('更新安装包格式或平台不正确。');
}
async function verified(path, asset) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== asset.bytes) return false;
    const h = createHash('sha256');
    for await (const b of createReadStream(path)) h.update(b);
    return h.digest('hex') === asset.sha256;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}
function createInstallerUpdater({
  directory,
  platform,
  open,
  progress = () => {},
  fetch: fetcher = fetch,
}) {
  let active = null,
    ready = null;
  let state = { state: 'idle', received: 0, total: 0 };
  const report = (value) => {
    state = value;
    progress(value);
  };
  return {
    status: () => state,
    async download({ url, asset }) {
      if (active) throw new Error('已有更新正在下载。');
      validateDownload(url, asset, platform);
      const controller = new AbortController();
      active = controller;
      let temp;
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const path = join(directory, asset.name);
        if (await verified(path, asset)) {
          ready = { path, asset };
          report({ state: 'ready', received: asset.bytes, total: asset.bytes });
          return { ready: true };
        }
        temp = path + '.part';
        await rm(temp, { force: true });
        const r = await fetcher(url, { signal: controller.signal, redirect: 'error' });
        if (!r.ok || !r.body) throw new Error('更新下载失败，请重新检查更新。');
        const hash = createHash('sha256');
        let received = 0,
          last = 0;
        report({ state: 'downloading', received, total: asset.bytes });
        await pipeline(
          Readable.fromWeb(r.body),
          new Transform({
            transform(chunk, _encoding, callback) {
              received += chunk.length;
              if (received > asset.bytes) {
                callback(new Error('更新文件超出清单大小。'));
                return;
              }
              hash.update(chunk);
              if (Date.now() - last > 200) {
                last = Date.now();
                report({ state: 'downloading', received, total: asset.bytes });
              }
              callback(null, chunk);
            },
          }),
          createWriteStream(temp, { mode: 0o600, flags: 'wx' }),
          { signal: controller.signal },
        );
        if (received !== asset.bytes || hash.digest('hex') !== asset.sha256)
          throw new Error('更新文件校验失败，安装已阻止。');
        await rename(temp, path);
        temp = null;
        ready = { path, asset };
        report({ state: 'ready', received, total: asset.bytes });
        return { ready: true };
      } catch (e) {
        report({
          state: controller.signal.aborted ? 'cancelled' : 'error',
          received: 0,
          total: asset.bytes,
        });
        throw e;
      } finally {
        if (temp) await rm(temp, { force: true });
        active = null;
      }
    },
    cancel() {
      active?.abort();
    },
    async install() {
      if (!ready || !(await verified(ready.path, ready.asset)))
        throw new Error('请先下载并校验安装包。');
      const error = await open(ready.path);
      if (error) throw new Error('无法打开安装包：' + error);
      return { opened: true };
    },
  };
}
module.exports = { createInstallerUpdater, validateDownload };
