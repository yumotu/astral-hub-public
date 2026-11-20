import { cp, mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, basename, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const exists = async (path) =>
  !!(await stat(path).catch((e) => {
    if (e.code !== 'ENOENT') throw e;
  }));
const aborted = (signal) => {
  if (signal?.aborted) throw new Error('插件操作已取消，原插件保持不变。');
};
export async function recoverPackages(root) {
  root = resolve(root);
  const journal = root + '.transaction.json';
  try {
    const { candidate } = JSON.parse(await readFile(journal, 'utf8'));
    if (
      dirname(candidate) !== dirname(root) ||
      !basename(candidate).startsWith(basename(root) + '.candidate-')
    )
      throw new Error('插件恢复记录路径无效。');
    if (!(await exists(root)) && (await exists(root + '.previous')))
      await rename(root + '.previous', root);
    if (!(await exists(root))) throw new Error('插件恢复失败：原目录与备份均不存在。');
    await rm(candidate, { recursive: true, force: true });
    await rm(journal, { force: true });
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  // Only at bridge startup or after confirming the installer process is dead.
  await rm(root + '.lock', { recursive: true, force: true });
}

export async function recoverPackagesForTurn(root) {
  if (!(await exists(root + '.lock')) && !(await exists(root + '.transaction.json'))) return;
  if (await exists(root + '.lock')) {
    let owner;
    try {
      owner = JSON.parse(await readFile(root + '.lock/owner.json', 'utf8'));
    } catch {}
    let alive = true;
    if (Number.isInteger(owner?.pid) && owner.pid > 0)
      try {
        process.kill(owner.pid, 0);
      } catch (e) {
        if (e.code === 'ESRCH') alive = false;
      }
    if (alive)
      throw Object.assign(new Error('插件变更正在进行，等待启用检查完成。'), { status: 429 });
  }
  await recoverPackages(root);
}

// Install/update into an independent copy. A failed import cannot alter the
// active settings OR transitive dependency bytes. Keep one complete last version.
export async function changePackages(root, { mutate, validate, signal, onStage } = {}) {
  root = resolve(root);
  await mkdir(dirname(root), { recursive: true, mode: 0o700 });
  try {
    await mkdir(root + '.lock', { mode: 0o700 });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let owner;
    try {
      owner = JSON.parse(await readFile(root + '.lock/owner.json', 'utf8'));
    } catch {}
    let alive = true;
    if (Number.isInteger(owner?.pid) && owner.pid > 0) {
      try {
        process.kill(owner.pid, 0);
      } catch (err) {
        if (err.code === 'ESRCH') alive = false;
      }
    }
    if (alive) throw new Error('另一个插件操作正在进行，请稍后重试。');
    await recoverPackages(root);
    await mkdir(root + '.lock', { mode: 0o700 });
  }
  const candidate = root + '.candidate-' + randomUUID(),
    previous = root + '.previous';
  const journal = root + '.transaction.json';
  let moved = false,
    committed = false;
  try {
    await writeFile(root + '.lock/owner.json', JSON.stringify({ pid: process.pid }), {
      mode: 0o600,
    });
    await writeFile(journal, JSON.stringify({ candidate }), { mode: 0o600 });
    aborted(signal);
    await mkdir(root, { recursive: true, mode: 0o700 });
    onStage?.('准备插件副本，当前版本继续保留。');
    await cp(root, candidate, {
      recursive: true,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
    });
    aborted(signal);
    await mutate(candidate);
    aborted(signal);
    onStage?.('检查完整插件组合能否启动 Pi。');
    const checked = await validate(candidate);
    if (!checked?.ready) throw new Error('插件启用检查未通过，原插件保持不变。');
    aborted(signal);
    await rm(previous, { recursive: true, force: true });
    await rename(root, previous);
    moved = true;
    await rename(candidate, root);
    committed = true;
    await rm(journal, { force: true });
    return checked;
  } catch (e) {
    if (moved && !committed) await rename(previous, root);
    throw e;
  } finally {
    await rm(candidate, { recursive: true, force: true });
    if (!moved || committed || (await exists(root))) await rm(journal, { force: true });
    await rm(root + '.lock', { recursive: true, force: true });
  }
}
