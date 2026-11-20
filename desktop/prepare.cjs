const { cpSync, rmSync, existsSync } = require('node:fs');
const { resolve } = require('node:path');
const dist = resolve(__dirname, '../dist');
if (!existsSync(resolve(dist, 'index.html')))
  throw new Error('请先在项目根目录运行 npm run build。');
rmSync(resolve(__dirname, 'web'), { recursive: true, force: true });
cpSync(dist, resolve(__dirname, 'web'), { recursive: true });
