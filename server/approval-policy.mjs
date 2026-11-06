import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { fail } from './accounts.mjs';

const schema = z
  .object({
    mode: z.enum(['manual', 'rules', 'assist', 'full']),
    targets: z
      .array(z.enum(['pi', 'server']))
      .min(1)
      .max(2)
      .default(['pi']),
    minutes: z.number().int().min(1).max(120).nullable().default(null),
    acknowledged: z.boolean().default(false),
  })
  .strict();
const digest = (s) => createHash('sha256').update(s).digest('hex');
// Deliberately a restricted grammar, never a shell parser or an LLM's guess.
const words = (command) =>
  /^[A-Za-z0-9_./:@%+=, -]+$/.test(command) && !command.includes('\n')
    ? command.trim().split(/ +/)
    : null;
const readOnly = (command) => {
  const w = words(command);
  if (!w) return false;
  if (w[0] === 'pwd') return w.length === 1;
  if (['node', 'python3', 'npm', 'git'].includes(w[0]) && w.length === 2 && w[1] === '--version')
    return true;
  if (w[0] === 'ls')
    return w
      .slice(1)
      .every((x) => !x.startsWith('--') || ['--all', '--long', '--human-readable'].includes(x));
  if (w[0] === 'git' && ['status', 'diff', 'log', 'show'].includes(w[1]))
    return w
      .slice(2)
      .every(
        (x) =>
          !x.startsWith('--output') &&
          !x.includes('ext-diff') &&
          !x.includes('textconv') &&
          !x.startsWith('-c'),
      );
  return false;
};
export function commandFamily(command) {
  const w = words(command);
  if (!w || !readOnly(command)) return null;
  // Only read-only inspection families are broadened; arbitrary scripts can be
  // remembered exactly or covered by an explicitly chosen full-access policy.
  return JSON.stringify(w.slice(0, w[0] === 'git' ? 2 : 1));
}
export function createApprovalPolicy(db, now = Date.now) {
  db.exec(`CREATE TABLE IF NOT EXISTS host_access_policies(owner TEXT NOT NULL,conversation TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(owner,conversation));
    CREATE TABLE IF NOT EXISTS host_access_grants(id TEXT PRIMARY KEY,owner TEXT NOT NULL,conversation TEXT NOT NULL,target TEXT NOT NULL,cwd TEXT NOT NULL,kind TEXT NOT NULL,pattern TEXT NOT NULL,expires_at INTEGER);
    CREATE TABLE IF NOT EXISTS host_access_decisions(id TEXT PRIMARY KEY,payload TEXT NOT NULL);`);
  const get = (owner, conversation) => {
    const row = db
      .prepare('SELECT payload FROM host_access_policies WHERE owner=? AND conversation=?')
      .get(owner, conversation);
    const p = row
      ? JSON.parse(row.payload)
      : { mode: 'manual', targets: ['pi'], expiresAt: null, revision: null };
    const expired = p.expiresAt !== null && p.expiresAt <= now();
    return {
      ...p,
      mode: expired ? 'manual' : p.mode,
      expired,
      rules: db
        .prepare(
          'SELECT id,target,kind,expires_at AS expiresAt FROM host_access_grants WHERE owner=? AND conversation=? AND (expires_at IS NULL OR expires_at>?)',
        )
        .all(owner, conversation, now()),
    };
  };
  function set(owner, conversation, input) {
    const p = schema.parse(input);
    if (p.mode === 'full' && !p.acknowledged) throw fail(400, '请明确确认所选环境的完全执行权限。');
    const value = {
      mode: p.mode,
      targets: [...new Set(p.targets)],
      expiresAt: p.minutes === null ? null : now() + p.minutes * 60000,
      revision: randomUUID(),
    };
    db.prepare('INSERT OR REPLACE INTO host_access_policies VALUES(?,?,?)').run(
      owner,
      conversation,
      JSON.stringify(value),
    );
    if (p.mode === 'manual')
      db.prepare('DELETE FROM host_access_grants WHERE owner=? AND conversation=?').run(
        owner,
        conversation,
      );
    return get(owner, conversation);
  }
  function decide(owner, conversation, command) {
    const p = get(owner, conversation);
    const grant = db
      .prepare(
        'SELECT * FROM host_access_grants WHERE owner=? AND conversation=? AND target=? AND cwd=? AND (expires_at IS NULL OR expires_at>?)',
      )
      .all(owner, conversation, command.target, command.cwd || '', now())
      .find((g) =>
        g.kind === 'exact'
          ? g.pattern === digest(command.command)
          : g.pattern === commandFamily(command.command),
      );
    if (grant)
      return {
        kind: 'rule',
        revision: grant.id,
        expiresAt: grant.expires_at,
        reason:
          grant.kind === 'exact' ? '使用你批准的相同命令规则' : '使用你批准的只读同类命令规则',
      };
    if (!p.targets.includes(command.target)) return null;
    if (p.mode === 'full')
      return {
        kind: 'full',
        revision: p.revision,
        expiresAt: p.expiresAt,
        reason: '使用此对话的完全权限授权',
      };
    if (p.mode === 'assist' && readOnly(command.command))
      return {
        kind: 'assist',
        revision: p.revision,
        expiresAt: p.expiresAt,
        reason: '协助审核：受限语法内的只读检查；不包含脚本、重定向或复合命令',
      };
    return null;
  }
  function remember(owner, conversation, command, choice) {
    if (choice === 'once' || !choice) return;
    if (['15m', '60m', 'full'].includes(choice)) {
      set(owner, conversation, {
        mode: 'full',
        targets: [command.target],
        minutes: choice === 'full' ? null : Number(choice.slice(0, -1)),
        acknowledged: true,
      });
      return;
    }
    const family = choice === 'similar' ? commandFamily(command.command) : null;
    if (choice === 'similar' && !family)
      throw fail(400, '复合命令或写入命令不能扩大为同类规则，请选择原样命令或限时授权。');
    if (!['exact', 'similar'].includes(choice)) throw fail(400, '授权方式不正确。');
    const pattern = family || digest(command.command),
      kind = family ? 'family' : 'exact';
    const old = db
      .prepare(
        'SELECT id FROM host_access_grants WHERE owner=? AND conversation=? AND target=? AND cwd=? AND kind=? AND pattern=?',
      )
      .get(owner, conversation, command.target, command.cwd || '', kind, pattern);
    if (!old)
      db.prepare('INSERT INTO host_access_grants VALUES(?,?,?,?,?,?,?,NULL)').run(
        randomUUID(),
        owner,
        conversation,
        command.target,
        command.cwd || '',
        kind,
        pattern,
      );
  }
  function save(id, value) {
    db.prepare('INSERT OR REPLACE INTO host_access_decisions VALUES(?,?)').run(
      id,
      JSON.stringify(value),
    );
  }
  function valid(owner, conversation, id, command) {
    const row = db.prepare('SELECT payload FROM host_access_decisions WHERE id=?').get(id);
    if (!row) return true; // A human's one-use approval.
    const saved = JSON.parse(row.payload),
      current = decide(owner, conversation, command);
    return !!current && saved.kind === current.kind && saved.revision === current.revision;
  }
  return { get, set, decide, remember, save, valid };
}
