import { Type } from 'typebox';
export default function (pi) {
  const endpoint = process.env.ASTRAL_HOST_ACCESS_URL,
    token = process.env.ASTRAL_HOST_ACCESS_TOKEN;
  if (!endpoint || !token) return;
  async function call(path, data, signal, timeout = 15000) {
    const r = await fetch(endpoint + path, {
      method: data ? 'POST' : 'GET',
      headers: {
        Authorization: 'Bearer ' + token,
        ...(data ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
        : AbortSignal.timeout(timeout),
      redirect: 'error',
    });
    const value = await r.json();
    if (!r.ok) throw new Error(value.error || '宿主访问请求失败。');
    return value;
  }
  pi.registerTool({
    name: 'host_command',
    label: '申请宿主执行',
    description:
      '需要当前项目以外的文件、宿主联网、插件目录 npm audit 或安装脚本时，申请管理员批准具体命令；批准一次仅执行一次。pi 为 Pi 容器 node，server 为整台服务器 root，必须明确说明用途。未批准不能执行，不要把离线 Bash 当成宿主。',
    parameters: Type.Object(
      {
        target: Type.Union([Type.Literal('pi'), Type.Literal('server')]),
        command: Type.String({ minLength: 1, maxLength: 8000 }),
        cwd: Type.Optional(Type.String({ maxLength: 1000 })),
        reason: Type.String({ minLength: 1, maxLength: 1000 }),
        timeout: Type.Optional(Type.Integer({ minimum: 1000, maximum: 120000 })),
      },
      { additionalProperties: false },
    ),
    async execute(id, p, signal) {
      const grant = await call('/request', { callId: id, ...p }, signal);
      let state = grant.state;
      while (state === 'pending') {
        if (signal?.aborted) throw new Error('授权请求已停止。');
        await new Promise((resolve) => setTimeout(resolve, 1000));
        state = (await call('/' + grant.id + '/status', null, signal)).state;
      }
      if (state !== 'approved')
        return {
          content: [{ type: 'text', text: `宿主操作未执行：授权状态 ${state}。` }],
          details: { approvalId: grant.id, executed: false },
          isError: true,
        };
      const result = await call(
        '/' + grant.id + '/execute',
        {},
        signal,
        (p.timeout || 60000) + 15000,
      );
      return {
        content: [{ type: 'text', text: result.output || `命令结束，退出码 ${result.exitCode}。` }],
        details: { ...result, command: p.command },
        isError: result.exitCode !== 0,
      };
    },
  });
}
