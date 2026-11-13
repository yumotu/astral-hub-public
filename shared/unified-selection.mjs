import { z } from 'zod';
import { readAssistantSelection } from './assistant-resume.mjs';
import { assistantTargetStorageKey } from './assistant-target.mjs';
const selection = z
  .object({ origin: z.enum(['server', 'computer', 'remote']), nativeId: z.string().uuid() })
  .strict();
export const unifiedSelectionKey = (server, owner) =>
  'astral.assistant.unified:' + JSON.stringify([server, owner]);
export function readUnifiedSelection(storage, legacy, { server, url, owner }) {
  const key = unifiedSelectionKey(server, owner);
  try {
    const raw = storage.getItem(key);
    if (raw === 'null') return null;
    const parsed = selection.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {}
  const driver = readAssistantSelection(
    storage,
    legacy,
    `astral.agent.last:${url}:${owner}`,
    'driver',
  );
  const remote = readAssistantSelection(
    storage,
    legacy,
    `astral.dsh.last:${url}:${owner}`,
    'conversation',
  );
  const computer = readAssistantSelection(
    storage,
    legacy,
    assistantTargetStorageKey(server, owner),
    'computer',
  );
  const pi = readAssistantSelection(
    storage,
    legacy,
    `astral.pi.last:${url}:${owner}`,
    'conversation',
  );
  const value =
    driver === 'dsh' && remote
      ? { origin: 'remote', nativeId: remote }
      : computer
        ? { origin: 'computer', nativeId: computer.conversationId }
        : pi
          ? { origin: 'server', nativeId: pi }
          : null;
  if (value) saveUnifiedSelection(storage, key, value);
  return value;
}
export function saveUnifiedSelection(storage, key, value) {
  try {
    storage.setItem(key, JSON.stringify(value === null ? null : selection.parse(value)));
    return true;
  } catch {
    return false;
  }
}
export function activeUnifiedSelection(conversations, selected) {
  const c =
    selected &&
    conversations.find((c) =>
      c.segments.some((s) => s.origin === selected.origin && s.nativeId === selected.nativeId),
    );
  return c ? { origin: c.active.origin, nativeId: c.active.nativeId } : selected;
}

// Only retain operation identities, never prompts, credentials or authorization.
// Reading this journal does not retry anything: explicit user action is required.
export function createUnifiedOperationJournal(storage, scope) {
  const key = scope + ':operations';
  let entries = {};
  try {
    const parsed = z
      .record(z.string(), z.string().uuid())
      .safeParse(JSON.parse(storage.getItem(key)));
    if (parsed.success) entries = parsed.data;
  } catch {}
  const persist = () => {
    try {
      storage.setItem(key, JSON.stringify(entries));
    } catch {}
  };
  return {
    id(operation) {
      if (!Object.hasOwn(entries, operation)) {
        entries[operation] = crypto.randomUUID();
        persist();
      }
      return entries[operation];
    },
    complete(operation) {
      delete entries[operation];
      persist();
    },
  };
}
