import { z } from 'zod';

const target = z
  .object({
    deviceId: z.string().uuid(),
    projectId: z.string().uuid(),
    conversationId: z.string().uuid(),
    panel: z.enum(['files', 'terminal', 'plugins']).optional(),
  })
  .strict();

export function assistantTargetStorageKey(server, owner) {
  return 'astral.assistant.target:' + JSON.stringify([server, owner]);
}

export function readAssistantTarget(storage, key) {
  try {
    return target.parse(JSON.parse(storage.getItem(key)));
  } catch {
    return null;
  }
}

export function computerChatStorageKey(server, owner, deviceId, projectId) {
  return 'astral.computer.chat:' + JSON.stringify([server, owner, deviceId, projectId]);
}

export function readComputerChatDraft(storage, key) {
  try {
    const id = z.string().uuid().parse(storage.getItem(key));
    const input = storage.getItem(key + ':draft:' + id);
    if (typeof input === 'string' && input.trim() && input.length <= 8000) return { id, input };
    const files = JSON.parse(storage.getItem(key + ':attachments:' + id) || '[]');
    return Array.isArray(files) &&
      files.length > 0 &&
      files.length <= 8 &&
      files.every((f) => z.string().uuid().safeParse(f?.id).success)
      ? { id, input: '附件草稿' }
      : null;
  } catch {
    return null;
  }
}
