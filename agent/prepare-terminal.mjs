import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { lstat, chmod } from 'node:fs/promises';
const require = createRequire(import.meta.url),
  root = dirname(require.resolve('node-pty/package.json'));
if (process.platform !== 'win32') {
  // node-pty 1.1.0's npm prebuild contains a non-executable spawn-helper. Its
  // install/postinstall scripts do not repair the mode. Touch only these exact
  // helper files inside this installed, pinned dependency.
  for (const relative of [
    'build/Release/spawn-helper',
    'build/Debug/spawn-helper',
    `prebuilds/${process.platform}-${process.arch}/spawn-helper`,
  ]) {
    const path = join(root, relative);
    let info;
    try {
      info = await lstat(path);
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw e;
    }
    if (!info.isFile() || info.isSymbolicLink())
      throw Error('终端启动器不是普通文件，请重新安装依赖。');
    await chmod(path, 0o755);
  }
}
if (typeof require('node-pty').spawn !== 'function') throw Error('本机终端模块未就绪。');
console.log('本机终端组件已准备；使用终端仍需该项目的 --allow-execute 授权。');
