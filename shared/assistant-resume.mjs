import { z } from 'zod';

const schemas = {
  driver: z.enum(['pi', 'dsh']),
  conversation: z.string().uuid(),
  computer: z
    .object({
      deviceId: z.string().uuid(),
      projectId: z.string().uuid(),
      conversationId: z.string().uuid(),
      panel: z.enum(['files', 'terminal', 'plugins']).optional(),
    })
    .strict(),
};

// These records select a view only. Never store credentials or restore a grant.
export function saveAssistantSelection(storage, key, kind, value) {
  try {
    if (value === null) storage.removeItem(key);
    else
      storage.setItem(
        key,
        kind === 'computer'
          ? JSON.stringify(schemas[kind].parse(value))
          : schemas[kind].parse(value),
      );
    return true;
  } catch {
    return false;
  }
}

export function readAssistantSelection(storage, legacy, key, kind) {
  for (const source of [storage, legacy]) {
    try {
      const raw = source?.getItem(key);
      if (!raw) continue;
      const value = schemas[kind].parse(kind === 'computer' ? JSON.parse(raw) : raw);
      if (source !== storage) {
        saveAssistantSelection(storage, key, kind, value);
        legacy.removeItem(key);
      }
      return value;
    } catch {
      /* A damaged or unavailable store cannot select another account. */
    }
  }
  return null;
}
