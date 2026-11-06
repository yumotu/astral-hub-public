import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
try {
  await writeFile(
    '.env',
    (await readFile('.env.example', 'utf8'))
      .replace('APP_TOKEN=', 'APP_TOKEN=' + randomBytes(32).toString('hex'))
      .replace('PI_BRIDGE_TOKEN=', 'PI_BRIDGE_TOKEN=' + randomBytes(32).toString('hex')),
    { flag: 'wx', mode: 0o600 },
  );
  console.log(
    '已创建 .env，访问令牌为 APP_TOKEN。服务器模式在 .env 填写 DEEPSEEK_API_KEY；本机模式在设备设置中填写。',
  );
} catch (e) {
  if (e.code === 'EEXIST') console.log('.env 已存在，已保留。');
  else throw e;
}
