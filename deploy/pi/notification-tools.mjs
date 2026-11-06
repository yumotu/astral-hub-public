import { Type } from 'typebox';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export default async function (pi) {
  // Pi rewrites settings.json using its own schema; keep extension state separately.
  const file = join(process.env.PI_CODING_AGENT_DIR, 'astral-notifications.json');
  let enabled = true;
  try {
    enabled = JSON.parse(await readFile(file, 'utf8')).enabled !== false;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const message = (type, content, details) =>
    pi.sendMessage({ customType: type, content, details, display: true });
  function notify(title, body) {
    if (!enabled) throw new Error('此对话通知已关闭，可用 /notify on 开启。');
    message('astral-notification', '通知已提交星屿通知接口；系统展示由设备通知权限决定。', {
      id: randomUUID(),
      title,
      body,
    });
  }
  pi.registerTool({
    name: 'notify',
    label: '通知设备',
    description:
      '向当前用户的星屿通知中心和已启用通知的手机、桌面、网页设备发送消息。不要运行 notify-send 或输出终端 OSC。',
    parameters: Type.Object(
      {
        title: Type.String({ minLength: 1, maxLength: 120 }),
        body: Type.String({ maxLength: 1200 }),
      },
      { additionalProperties: false },
    ),
    async execute(_id, p) {
      notify(p.title, p.body);
      return {
        content: [{ type: 'text', text: '通知已提交星屿接口。' }],
        details: { transport: 'astral' },
      };
    },
  });
  pi.registerCommand('notify', {
    description: '星屿跨端通知：test [消息]、status、on、off',
    async handler(raw) {
      const text = raw.trim();
      if (['on', 'off'].includes(text)) {
        enabled = text === 'on';
        await writeFile(file, JSON.stringify({ enabled }), {
          mode: 0o600,
        });
        message('astral-notification-policy', `此对话通知已${enabled ? '开启' : '关闭'}。`, {
          enabled,
        });
        return;
      }
      if (text === 'status') {
        message(
          'astral-notification-status',
          `通知通道：星屿统一通知接口\n此对话：${enabled ? '开启' : '关闭'}\n设备权限、后台推送与通知记录请在「连接与设置 → 通知」查看。`,
          {},
        );
        return;
      }
      const body = text.replace(/^test(?:\s|$)/, '').trim() || '这是一条来自 Pi 的跨端通知测试。';
      notify('Pi 通知测试', body.slice(0, 1200));
    },
  });
}
