import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { cleanDiagnostic, runtimeDiagnostic } from './runtime-diagnostics.mjs';

export async function saveActivation(root, state) {
  const file = root + '.activation.json',
    next = file + '.' + randomUUID();
  await writeFile(next, JSON.stringify(state), { mode: 0o600 });
  await rename(next, file);
}

// Use the real worker, same adapter selection, and the maintained Pi RPC client.
// This only handshakes and inspects state/commands; it sends no model prompt.
export async function checkPackageActivation(root, { signal, onUpdate, coreOnly = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'astral-plugin-check-'));
  let child;
  try {
    await mkdir(join(dir, 'home'), { mode: 0o700 });
    await mkdir(join(dir, 'skills'), { mode: 0o700 });
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({ enableAnalytics: false, enableInstallTelemetry: false }),
    );
    await writeFile(
      join(dir, 'models.json'),
      await readFile(new URL('./models.json', import.meta.url)),
    );
    await writeFile(join(dir, 'projects.json'), '[]');
    await writeFile(join(dir, 'chat-files.json'), '[]');
    await writeFile(
      join(dir, 'web-search.json'),
      await readFile(new URL('./web-search.json', import.meta.url)),
    );
    if (signal?.aborted) throw new Error('插件启用检查已取消。');
    // Native packages can start detached daemons during import/session_start.
    // A private PID namespace kills all probe descendants on exit, including
    // detached children. Keep the real runtime and registered local sources
    // readable, with only candidate settings and the disposable HOME writable.
    const sandbox = [
      '--die-with-parent',
      '--new-session',
      '--unshare-all',
      '--cap-drop',
      'ALL',
      ...['/usr', '/bin', '/lib', '/etc', '/bridge', '/extensions', '/projects'].flatMap((path) => [
        '--ro-bind',
        path,
        path,
      ]),
      '--dev',
      '/dev',
      '--tmpfs',
      '/tmp',
      '--bind',
      dir,
      dir,
      '--bind',
      root,
      root,
      '--chdir',
      dir,
      process.execPath,
      new URL('./rpc-worker.mjs', import.meta.url).pathname,
    ];
    child = spawn('bwrap', sandbox, {
      cwd: dir,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        HOME: join(dir, 'home'),
        LANG: 'C.UTF-8',
        NO_COLOR: '1',
        TERM: 'dumb',
        TZ: 'Asia/Shanghai',
        PI_TELEMETRY: '0',
        PI_OFFLINE: '1',
        NODE_OPTIONS: '--max-old-space-size=384',
        PI_CODING_AGENT_DIR: dir,
        ASTRAL_PACKAGES_ROOT: root,
        ASTRAL_SKILLS_ROOT: join(dir, 'skills'),
        ASTRAL_SKILLS_WRITE: '1',
        ASTRAL_ACTIVATION_PROBE: '1',
        ASTRAL_CORE_ONLY: coreOnly ? '1' : '0',
        ASTRAL_CHAT_FILES_FILE: join(dir, 'chat-files.json'),
        ASTRAL_PROJECTS_FILE: join(dir, 'projects.json'),
        PI_WEB_ACCESS_CACHE_ROOT: join(dir, 'web-cache'),
        DEEPSEEK_API_KEY: 'activation-check-no-model-call',
        ASTRAL_MAIL_ACCESS_URL: 'http://127.0.0.1:1/activation-check-no-mail-call',
        ASTRAL_MAIL_ACCESS_TOKEN: 'activation-check-no-mail-call',
      },
    });
    let output = '',
      stderr = '',
      size = 0,
      expired = false,
      cancelled = false;
    const decoder = new StringDecoder('utf8');
    const kill = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const abort = () => {
      cancelled = true;
      kill();
    };
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      expired = true;
      kill();
    }, 45000);
    child.stdin.on('error', () => {});
    child.stdout.on('data', (b) => {
      size += b.length;
      if (size > 2 * 1024 * 1024) kill();
      else output += decoder.write(b);
    });
    child.stderr.on('data', (b) => {
      stderr = (stderr + cleanDiagnostic(b.toString())).slice(-16000);
    });
    let code;
    try {
      const closed = new Promise((resolve, reject) => {
        child.once('close', resolve);
        child.once('error', reject);
      });
      child.stdin.end(
        JSON.stringify({
          action: 'inspect',
          canManageSkills: true,
          sessionKey: 'f'.repeat(64),
          sessionDir: dir,
          cwd: dir,
          model: 'deepseek-flash',
          thinkingLevel: 'off',
        }) + '\n',
      );
      code = await closed;
      output += decoder.end();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
    const records = output
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      });
    const result = records.findLast((r) => r?.type === 'done' || r?.type === 'error');
    if (code !== 0 || !result || result.type === 'error' || expired || cancelled) {
      const diagnostic =
        result?.diagnostic ||
        runtimeDiagnostic(
          new Error(
            cancelled
              ? '插件启用检查已取消。'
              : expired
                ? '插件启用检查超时。'
                : result?.error || 'Pi 插件启用检查失败。',
          ),
          { stderr, exitCode: code, phase: 'startup' },
        );
      throw Object.assign(new Error(diagnostic.message + '\n' + diagnostic.details), {
        diagnostic,
      });
    }
    onUpdate?.('Pi 启动检查通过。');
    return {
      ready: true,
      checkedAt: new Date().toISOString(),
      plugins: result.plugins,
      commands: result.commands?.map((c) => c.name) || [],
    };
  } finally {
    if (child?.exitCode === null) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }
    await rm(dir, { recursive: true, force: true });
  }
}
