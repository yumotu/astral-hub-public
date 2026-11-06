import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { localGrant, saveConfig } from '../config.mjs';
import { createLocalWorkspace } from '../workspace.mjs';
import { createComputerTerminals } from '../terminal-runtime.mjs';
import { localEnvironment } from '../process-tree.mjs';
import executeTools from '../execute-tools.mjs';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function eventually(fn) {
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fn();
      if (r) return r;
    } catch {}
    await pause(50);
  }
  throw Error('Native runtime condition timed out');
}
const quote = (s) =>
  process.platform === 'win32'
    ? "'" + s.replaceAll("'", "''") + "'"
    : "'" + s.replaceAll("'", "'\"'\"'") + "'";
const command = (code) =>
  (process.platform === 'win32' ? '& ' : '') + quote(process.execPath) + ' -e ' + quote(code);
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'astral native 083-')),
    root = join(dir, 'project');
  await mkdir(root);
  const grant = await localGrant(root, { allowWrite: true, allowExecute: true }),
    configPath = join(dir, 'device.json'),
    config = {
      server: 'http://127.0.0.1:1',
      deviceId: randomUUID(),
      token: 'synthetic-only',
      projects: [grant],
    };
  await saveConfig(configPath, config, { create: true });
  const cleanup = [];
  t.after(async () => {
    for (const action of cleanup.reverse()) await action();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, root, grant, config, configPath, beforeRemove: (action) => cleanup.push(action) };
}
test('native command adapter executes in its grant, excludes parent secrets, cancels descendants and rejects revoked permissions', async (t) => {
  const f = await fixture(t),
    env = {
      ASTRAL_DEVICE_CONFIG: f.configPath,
      ASTRAL_DEVICE_PROJECT: f.grant.id,
      ASTRAL_DEVICE_ROOT: f.grant.root,
      ASTRAL_DEVICE_INO: String(f.grant.ino),
      ASTRAL_DEVICE_DEV: String(f.grant.dev),
      ASTRAL_DEVICE_EXECUTE: '1',
      ASTRAL_PROJECT_ACCESS: 'edit',
      ASTRAL_SYNTHETIC_SECRET: 'must-not-reach-command',
    };
  const previous = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [k, v] of Object.entries(previous))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });
  assert.equal(localEnvironment().ASTRAL_SYNTHETIC_SECRET, undefined);
  let tool;
  executeTools({ registerTool: (spec) => (tool = spec) });
  assert.ok(tool);
  const file = join(f.root, 'command.json');
  const result = await tool.execute(
    randomUUID(),
    {
      command: command(
        `require('node:fs').writeFileSync(${JSON.stringify(file)},JSON.stringify({cwd:process.cwd(),secret:process.env.ASTRAL_SYNTHETIC_SECRET||null}));console.log('native-command-ok')`,
      ),
      timeout: 10000,
    },
    new AbortController().signal,
  );
  assert.equal(result.details.exitCode, 0);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { cwd: f.grant.root, secret: null });
  const counter = join(f.root, 'counter'),
    pidfile = join(f.root, 'descendant-pid');
  const child = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidfile)},String(process.pid));setInterval(()=>fs.appendFileSync(${JSON.stringify(counter)},'x'),60)`;
  const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'inherit'});setInterval(()=>{},1000)`;
  const controller = new AbortController();
  const pending = tool
    .execute(randomUUID(), { command: command(parent), timeout: 10000 }, controller.signal)
    .catch((e) => e);
  await eventually(() => readFile(counter, 'utf8'));
  controller.abort();
  await pending;
  await pause(200);
  const stopped = await readFile(counter, 'utf8');
  await pause(250);
  assert.equal(
    await readFile(counter, 'utf8'),
    stopped,
    'command descendant survived cancellation',
  );
  f.grant.allowExecute = false;
  await saveConfig(f.configPath, f.config);
  await assert.rejects(
    () =>
      tool.execute(
        randomUUID(),
        { command: command("throw Error('must not execute')") },
        new AbortController().signal,
      ),
    /授权/,
  );
});
test('real PTY input, resize, cursor acknowledgement, idempotency and close operate without replay', async (t) => {
  const previousSecret = process.env.ASTRAL_SYNTHETIC_PTY_SECRET;
  process.env.ASTRAL_SYNTHETIC_PTY_SECRET = 'must-not-enter-terminal-worker';
  t.after(() => {
    if (previousSecret === undefined) delete process.env.ASTRAL_SYNTHETIC_PTY_SECRET;
    else process.env.ASTRAL_SYNTHETIC_PTY_SECRET = previousSecret;
  });
  const f = await fixture(t),
    runtime = createComputerTerminals({ projects: () => [f.grant] }),
    ledgerFile = join(f.dir, 'operations.sqlite');
  const workspace = await createLocalWorkspace({
    projects: () => [f.grant],
    backupDir: join(f.dir, 'backups'),
    ledgerFile,
    terminals: runtime,
  });
  f.beforeRemove(async () => {
    await runtime.close();
    workspace.close();
  });
  const id = randomUUID(),
    op = (kind, extra = {}) => ({
      id: randomUUID(),
      projectId: f.grant.id,
      sessionId: id,
      kind,
      issuedAt: Date.now(),
      ...extra,
    });
  async function scriptCommand(name, code) {
    // Windows PowerShell 5.1 strips embedded quotes from native -e arguments.
    // Execute a fixture file so this tests PTY transport rather than that parser.
    const path = join(f.root, name + '.cjs');
    await writeFile(path, code);
    return (
      (process.platform === 'win32' ? '& ' : '') +
      quote(process.execPath) +
      ' ' +
      quote(path) +
      '\r'
    );
  }
  await workspace.handle(op('terminal_open', { cols: 80, rows: 24 }));
  if (process.platform === 'win32') {
    // The browser's xterm responds to DA/DSR before PowerShell reads a command.
    // This transport-only test has no renderer: emulate that peer and wait for
    // its prompt instead of racing shell initialization with the first input.
    let cursor = 0,
      pending = '',
      screen = '';
    try {
      await eventually(async () => {
        for (const chunk of runtime.snapshots()[0].chunks.filter((c) => c.seq > cursor)) {
          cursor = chunk.seq;
          pending += chunk.data;
          screen += chunk.data;
        }
        const replies = [];
        pending = pending
          .replace(/\x1b\[(?:0?c|>0?c|5n|6n)/g, (q) => {
            replies.push(
              q.endsWith('5n')
                ? '\x1b[0n'
                : q.endsWith('6n')
                  ? '\x1b[1;1R'
                  : q.includes('>')
                    ? '\x1b[>0;276;0c'
                    : '\x1b[?1;2c',
            );
            return '';
          })
          .slice(-128);
        for (const data of replies) await workspace.handle(op('terminal_input', { data }));
        const plain = screen
          .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
          .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
        return /PS [^\r\n]*>/.test(plain);
      });
    } catch (e) {
      throw Error(e.message + '; startup PTY=' + JSON.stringify(runtime.snapshots()));
    }
  }
  const file = join(f.root, 'pty.json');
  const input = op('terminal_input', {
    data: await scriptCommand(
      'pty-create',
      `const fs=require('node:fs');let n=0;try{n=JSON.parse(fs.readFileSync(${JSON.stringify(file)},'utf8')).n}catch{};fs.writeFileSync(${JSON.stringify(file)},JSON.stringify({n:n+1,cols:process.stdout.columns,rows:process.stdout.rows,secret:process.env.ASTRAL_SYNTHETIC_PTY_SECRET||null}));console.log(Buffer.from('cHR5LW5hdGl2ZS1vaw==','base64').toString())`,
    ),
  });
  await workspace.handle(input);
  await workspace.handle(input);
  try {
    await eventually(async () => JSON.parse(await readFile(file, 'utf8')).n === 1);
  } catch (e) {
    throw Error(e.message + '; PTY=' + JSON.stringify(runtime.snapshots()));
  }
  let output = '';
  assert.equal(JSON.parse(await readFile(file, 'utf8')).secret, null);
  await eventually(() => {
    const s = runtime.snapshots()[0];
    output += s.chunks.map((c) => c.data).join('');
    if (s.chunks.length) runtime.acknowledge({ acks: { [id]: s.chunks.at(-1).seq } });
    return output.includes('pty-native-ok');
  });
  assert.ok(output.length);
  assert.deepEqual(runtime.snapshots()[0].chunks, []);
  await workspace.handle(op('terminal_resize', { cols: 45, rows: 12 }));
  const sizeFile = join(f.root, 'size.json');
  await workspace.handle(
    op('terminal_input', {
      data: await scriptCommand(
        'pty-size',
        `require('node:fs').writeFileSync(${JSON.stringify(sizeFile)},JSON.stringify({cols:process.stdout.columns,rows:process.stdout.rows}))`,
      ),
    }),
  );
  assert.deepEqual(await eventually(async () => JSON.parse(await readFile(sizeFile, 'utf8'))), {
    cols: 45,
    rows: 12,
  });
  await assert.rejects(
    () =>
      workspace.handle(
        op('terminal_input', { data: 'must-not-run', issuedAt: Date.now() - 11000 }),
      ),
    /过期/,
  );
  const counter = join(f.root, 'pty-counter'),
    pidfile = join(f.root, 'pty-pid');
  const program = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidfile)},String(process.pid));setInterval(()=>fs.appendFileSync(${JSON.stringify(counter)},'x'),60)`;
  f.beforeRemove(async () => {
    try {
      process.kill(Number(await readFile(pidfile, 'utf8')), 'SIGKILL');
    } catch {}
  });
  await workspace.handle(op('terminal_input', { data: await scriptCommand('pty-child', program) }));
  await eventually(() => readFile(counter, 'utf8'));
  await workspace.handle(op('terminal_close'));
  await pause(300);
  const stopped = await readFile(counter, 'utf8');
  await pause(250);
  assert.equal(await readFile(counter, 'utf8'), stopped, 'PTY foreground child survived close');
  await assert.rejects(
    () => workspace.handle(op('terminal_input', { data: 'must-not-run' })),
    /关闭/,
  );
  assert.equal(JSON.parse(await readFile(file, 'utf8')).n, 1);
});
