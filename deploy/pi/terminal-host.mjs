import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { createTerminalRuntime, terminalSchema } from './terminal-runtime.mjs';
const token = process.env.TERMINAL_BRIDGE_TOKEN || '';
if (token.length < 32) throw new Error('Terminal bridge token is required');
const schema = terminalSchema(z),
  runtime = await createTerminalRuntime({ target: 'server', defaultCwd: '/opt/astral-hub' });
const server = createServer(async (req, res) => {
  const send = (status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  const supplied = Buffer.from((req.headers.authorization || '').replace(/^Bearer /, '')),
    expected = Buffer.from(token);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    send(401, { error: 'Unauthorized' });
    return;
  }
  try {
    if (req.url === '/health') {
      send(200, { ok: true, target: 'server', node: process.version });
      return;
    }
    if (req.url !== '/terminal' || req.method !== 'POST') {
      send(404, { error: 'Not found' });
      return;
    }
    const chunks = [];
    let bytes = 0;
    for await (const c of req) {
      bytes += c.length;
      if (bytes > 32000) throw Object.assign(Error('请求过大'), { status: 413 });
      chunks.push(c);
    }
    send(200, await runtime.handle(schema.parse(JSON.parse(Buffer.concat(chunks).toString()))));
  } catch (e) {
    send(e instanceof z.ZodError ? 400 : e.status || 500, {
      error: e.status ? e.message : '终端请求失败。',
    });
  }
});
server.requestTimeout = 15000;
server.listen(Number(process.env.TERMINAL_PORT || 8791), process.env.TERMINAL_BIND || '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    runtime.close();
    server.close();
    server.closeIdleConnections();
  });
