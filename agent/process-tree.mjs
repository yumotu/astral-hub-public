import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
export function localEnvironment() {
  const keys = [
    'PATH',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'HOME',
    'USERPROFILE',
    'LANG',
    'LC_ALL',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'PATHEXT',
  ];
  return {
    ...Object.fromEntries(keys.filter((k) => process.env[k]).map((k) => [k, process.env[k]])),
    PATH:
      dirname(process.execPath) +
      (process.platform === 'win32' ? ';' : ':') +
      (process.env.PATH || ''),
  };
}
export function terminateTree(child, force = false) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    const p = spawn(
      join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', ...(force ? ['/F'] : [])],
      { stdio: 'ignore', windowsHide: true },
    );
    p.on('error', () => child.kill());
  } else {
    try {
      process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
    } catch {
      try {
        child.kill(force ? 'SIGKILL' : 'SIGTERM');
      } catch {}
    }
  }
}
