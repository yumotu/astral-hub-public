import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCronLedger, scheduledId } from '../deploy/pi/cron-ledger.mjs';
const owner = '00000000-0000-4000-8000-000000000001';
const job = {
  id: 'job-one',
  name: 'daily',
  prompt: 'read project',
  tools: ['project_read'],
  skills: [],
};
const scope = {
  conversationId: '00000000-0000-4000-8000-000000000002',
  projectId: 'alpha',
  access: 'read',
  timeZone: 'Asia/Shanghai',
  toolNames: ['project_read'],
};
test('scheduled slots deduplicate across a host restart and retain their original scope', () => {
  const dir = mkdtempSync(join(tmpdir(), 'astral-cron-ledger-')),
    file = join(dir, 'runs.sqlite');
  let ledger = createCronLedger(file, owner);
  try {
    ledger.bind(job.id, scope);
    const run = ledger.enqueue(job, '2026-11-02T08:00:00Z', scope);
    assert.match(run.id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/);
    ledger.close();
    ledger = createCronLedger(file, owner);
    assert.equal(
      ledger.enqueue({ ...job, prompt: 'changed' }, run.scheduledAt, scope).input,
      run.input,
    );
    assert.equal(ledger.pending().length, 1);
    assert.deepEqual(ledger.context(job.id), scope);
    ledger.update(run.id, { status: 'interrupted', error: 'unknown result' });
    assert.equal(ledger.active(job.id), false);
    assert.equal(ledger.pending().length, 0);
    assert.equal(ledger.enqueue(job, run.scheduledAt, scope).status, 'interrupted');
    assert.equal(ledger.all().length, 1);
    assert.equal(ledger.unreported().length, 1);
    ledger.reported(run.id);
    assert.equal(ledger.unreported().length, 0);
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('slot keys include owner, job and scheduled time', () => {
  const id = scheduledId('a', 'b', 'c');
  assert.notEqual(id, scheduledId('a', 'b', 'd'));
  assert.notEqual(id, scheduledId('x', 'b', 'c'));
  assert.equal(id, scheduledId('a', 'b', 'c'));
});

test('cron adapter respects configured packages and rejects unvalidated versions', async () => {
  const { installedCron } = await import('../deploy/pi/cron-service.mjs');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const dir = mkdtempSync(join(tmpdir(), 'astral-cron-package-'));
  try {
    assert.equal(await installedCron(dir), null);
    await mkdir(join(dir, 'npm/node_modules/@patimweb/pi-cron'), { recursive: true });
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({ packages: ['npm:@patimweb/pi-cron'] }),
    );
    const meta = join(dir, 'npm/node_modules/@patimweb/pi-cron/package.json');
    await writeFile(meta, JSON.stringify({ version: '2.2.0' }));
    assert.equal((await installedCron(dir)).version, '2.2.0');
    await writeFile(meta, JSON.stringify({ version: '3.0.0' }));
    await assert.rejects(installedCron(dir), /尚未通过/);
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ packages: [] }));
    assert.equal(await installedCron(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
