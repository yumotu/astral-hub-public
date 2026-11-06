import { randomUUID } from 'node:crypto';
import { usageEvent } from './protocol.mjs';

// Pi 1.4 reports summaries and cache warming outside assistant message_end.
// These billing-only events never become user messages or add a model turn to
// the ordinary reply's UI metrics. A summary can aggregate multiple requests.
export function createAuxiliaryUsage({ model, now = Date.now, id = randomUUID }) {
  let compaction;
  const seen = new Set();
  return (e) => {
    if (['compaction_start', 'auto_compaction_start'].includes(e.type)) {
      if (compaction) return [];
      compaction = {
        requestId: id(),
        model,
        startedAt: new Date(now()).toISOString(),
        category: 'compaction',
      };
      return [{ type: 'billing_start', ...compaction }];
    }
    if (['compaction_end', 'auto_compaction_end'].includes(e.type)) {
      const current = compaction;
      compaction = null;
      const usage = usageEvent(e.result?.usage);
      return current && usage ? [{ ...usage, ...current, type: 'billing_usage' }] : [];
    }
    if (
      e.type === 'entry_appended' &&
      e.entry?.type === 'usage' &&
      e.entry.provider === 'astral-deepseek' &&
      typeof e.entry.id === 'string' &&
      e.entry.id.length <= 200 &&
      !seen.has(e.entry.id)
    ) {
      const usage = usageEvent(e.entry.usage);
      if (!usage) return [];
      seen.add(e.entry.id);
      return [
        {
          ...usage,
          type: 'billing_usage',
          requestId: 'entry:' + e.entry.id,
          model: e.entry.model || model,
          startedAt: e.entry.timestamp || new Date(now()).toISOString(),
          category: 'auxiliary',
          pricingUnknown: 'request_time_missing',
        },
      ];
    }
    return [];
  };
}
