import { fork } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { chmod, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { localEnvironment, terminateTree } from './process-tree.mjs';
import { checkGrant } from './workspace.mjs';
import { activityDeadline } from './assets/activity-deadline.mjs';
export async function createComputerTasks({
  config: configuration,
  configPath,
  backupDir,
  piEntry,
  ledgerFile,
  request,
}) {
  await mkdir(dirname(ledgerFile), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(ledgerFile);
  await chmod(ledgerFile, 0o600);
  db.exec(
    'PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,input TEXT NOT NULL,status TEXT NOT NULL,result TEXT)',
  );
  const active = new Map();
  let closed = false,
    closing;
  function stop(record) {
    if (record.stopped) return;
    record.stopped = true;
    record.child.send({ type: 'cancel' }, () => {});
    record.killTimer = setTimeout(() => terminateTree(record.child, true), 1500);
  }
  async function start(job) {
    if (closed) return;
    const config = configuration(),
      input = JSON.stringify(job),
      old = db.prepare('SELECT * FROM jobs WHERE id=?').get(job.id);
    const resultPath = '/device/workspace/jobs/' + job.id + '/result';
    if (old) {
      if (old.input !== input || old.status !== 'done') {
        await request(config, resultPath, {
          revision: 1,
          output: '',
          thinking: '',
          phase: '执行结果未知',
          tools: [],
          status: 'error',
          error: '本机已记录此任务，结果未知时不会自动重跑。',
        });
        return;
      }
      await request(config, resultPath, JSON.parse(old.result));
      return;
    }
    const grant = await checkGrant(config.projects.find((p) => p.id === job.projectId));
    if ((job.execute && !grant.allowExecute) || (job.access === 'edit' && !grant.allowWrite))
      throw Error('本机授权已变化。');
    db.prepare("INSERT INTO jobs VALUES(?,?,'started',NULL)").run(job.id, input);
    const child = fork(fileURLToPath(new URL('./task-worker.mjs', import.meta.url)), [], {
      cwd: grant.root,
      env: localEnvironment(),
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    const record = {
      child,
      job,
      grant,
      stopped: false,
      latest: null,
      dirty: false,
      sending: false,
      result: null,
      killTimer: null,
    };
    active.set(job.id, record);
    child.stderr.resume();
    let uploadTail = Promise.resolve();
    function upload(path, value) {
      uploadTail = uploadTail.catch(() => {}).then(() => request(configuration(), path, value));
      return uploadTail;
    }
    const report = () => {
      if (record.dirty && !record.sending && !record.result && !record.stopped) {
        record.dirty = false;
        record.sending = true;
        void upload('/device/workspace/jobs/' + job.id + '/progress', record.latest)
          .catch(() => {})
          .finally(() => {
            record.sending = false;
          });
      }
    };
    const progressTimer = setInterval(report, 250);
    let beating = false;
    async function beat() {
      if (beating || record.result) return;
      beating = true;
      try {
        const c = configuration(),
          current = await checkGrant(c.projects.find((p) => p.id === job.projectId));
        if (current.root !== grant.root || current.ino !== grant.ino || current.dev !== grant.dev)
          throw Error('本机授权目录已变化');
        if (
          (job.execute && !current.allowExecute) ||
          (job.access === 'edit' && !current.allowWrite)
        )
          throw Error('本机已撤销权限');
        const r = await request(c, '/device/heartbeat', { jobId: job.id });
        if (r.cancelled) stop(record);
        else
          for (const control of r.controls || [])
            child.send({ type: 'steer', ...control }, () => {});
      } catch {
        stop(record);
      } finally {
        beating = false;
      }
    }
    const heartbeat = setInterval(() => void beat(), 2000);
    const timeout = activityDeadline(920000, () => stop(record));
    const waiting = new Set();
    child.on('message', (message) => {
      if (message.type === 'progress') {
        timeout.touch();
        const next = new Set(
          (message.state.uiRequests || []).filter((r) => r.status !== 'resolved').map((r) => r.id),
        );
        for (const id of next) timeout.wait(id);
        for (const id of waiting) if (!next.has(id)) timeout.resume(id);
        waiting.clear();
        for (const id of next) waiting.add(id);
        record.latest = message.state;
        record.dirty = true;
        if (message.state.revision === 1) report();
      }
      if (message.type === 'control')
        void upload('/device/workspace/jobs/' + job.id + '/control', {
          id: message.id,
          status: message.status,
          ...(message.error ? { error: message.error } : {}),
        }).catch(() => {});
      if (message.type === 'result' && !record.result) {
        record.result = message.state;
        db.prepare("UPDATE jobs SET status='done',result=? WHERE id=?").run(
          JSON.stringify(record.result),
          job.id,
        );
        void upload(resultPath, record.result).catch(() => {});
      }
    });
    child.on('error', () => stop(record));
    child.once('exit', () => {
      clearInterval(progressTimer);
      clearInterval(heartbeat);
      timeout.close();
      clearTimeout(record.killTimer);
      if (!record.result) {
        const result = {
          revision: (record.latest?.revision || 0) + 1,
          output: record.latest?.output || '',
          thinking: record.latest?.thinking || '',
          tools: record.latest?.tools || [],
          phase: '已停止',
          status: record.stopped ? 'cancelled' : 'error',
          error: '本机进程已结束，未自动重放任务。',
        };
        db.prepare("UPDATE jobs SET status='done',result=? WHERE id=?").run(
          JSON.stringify(result),
          job.id,
        );
        void upload(resultPath, result).catch(() => {});
      }
      void uploadTail.finally(() => active.delete(job.id)).catch(() => {});
    });
    child.send({ type: 'start', job, config, configPath, backupDir, piEntry });
  }
  return {
    get size() {
      return active.size;
    },
    async poll() {
      if (closed || active.size >= 2) return;
      const r = await request(configuration(), '/device/workspace/jobs/poll?capacity=2');
      if (r.job)
        try {
          await start(r.job);
        } catch (e) {
          await request(configuration(), '/device/workspace/jobs/' + r.job.id + '/result', {
            revision: 1,
            output: '',
            thinking: '',
            phase: '启动失败',
            tools: [],
            status: 'error',
            error: String(e.message).slice(0, 1000),
          }).catch(() => {});
        }
    },
    revoke() {
      const c = configuration();
      for (const r of active.values()) {
        const p = c.projects.find((p) => p.id === r.job.projectId);
        if (
          !p ||
          p.root !== r.grant.root ||
          p.ino !== r.grant.ino ||
          p.dev !== r.grant.dev ||
          (r.job.access === 'edit' && !p.allowWrite) ||
          (r.job.execute && !p.allowExecute)
        )
          stop(r);
      }
    },
    async close() {
      if (closing) return closing;
      closing = (async () => {
        closed = true;
        for (const record of active.values()) stop(record);
        await Promise.all(
          [...active.values()].map(
            (r) =>
              new Promise((resolve) => {
                r.child.once('exit', resolve);
                if (r.child.exitCode !== null || r.child.signalCode !== null) resolve();
              }),
          ),
        );
        // Delivery callbacks may still need the ledger while the child exits.
        await new Promise((r) => setTimeout(r, 30));
        db.close();
      })();
      return closing;
    },
  };
}
