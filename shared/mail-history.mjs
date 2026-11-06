import { z } from 'zod';

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const parsed = new Date(v + 'T00:00:00.000Z');
    return Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === v;
  }, '请输入有效日期');
export const mailHistoryFields = {
  mailbox: z.string().trim().min(1).max(200).default('INBOX'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  q: z.string().trim().max(200).default(''),
  unread: z.boolean().default(false),
  since: date.optional(),
  before: date.optional(),
  cursor: z.string().min(1).max(1024).optional(),
};
export const mailHistorySchema = z
  .object(mailHistoryFields)
  .strict()
  .refine(
    (p) => !p.since || !p.before || p.since < p.before,
    '结束日期须晚于开始日期（结束日期当天不包含在内）',
  );
export const mailCacheSettingsSchema = z
  .object({
    cacheMB: z.number().int().min(16).max(1024).default(128),
    retentionDays: z.number().int().min(0).max(3650).default(365),
    pageSize: z.number().int().min(20).max(100).default(50),
  })
  .strict();
export const defaultMailCacheSettings = Object.freeze(mailCacheSettingsSchema.parse({}));

// Keep already loaded history when the latest page refreshes. Replace the
// authoritative UID interval so deletions/read-filter changes do not linger.
export function mergeMailHistory(previous, incoming, { older = false } = {}) {
  if (!previous || previous.uidValidity !== incoming.uidValidity) return incoming;
  const boundary = incoming.scannedFrom;
  const retained = older
    ? previous.messages
    : previous.messages.filter((m) => incoming.hasMore && boundary != null && m.uid < boundary);
  const rows = new Map(retained.map((m) => [m.uid, m]));
  for (const row of incoming.messages) rows.set(row.uid, row);
  const keepCursor = !older && incoming.hasMore && previous.messages.some((m) => m.uid < boundary);
  return {
    ...incoming,
    messages: [...rows.values()].sort((a, b) => b.uid - a.uid),
    ...(keepCursor ? { nextCursor: previous.nextCursor, hasMore: previous.hasMore } : {}),
    ...(older ? { total: previous.total } : {}),
  };
}
