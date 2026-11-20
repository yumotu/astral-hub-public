// Sidebar metadata must survive history refreshes and task snapshot recovery.
export function compareConversations(a, b) {
  return (
    Number(!!b.pinnedAt) - Number(!!a.pinnedAt) ||
    (b.pinnedAt || '').localeCompare(a.pinnedAt || '') ||
    b.updatedAt.localeCompare(a.updatedAt) ||
    a.id.localeCompare(b.id)
  );
}
/** @template T @param {T[]} items @param {boolean} archived @returns {T[]} */
export function visibleConversations(items, archived = false) {
  return items.filter((c) => !!c.archivedAt === archived).sort(compareConversations);
}
/**
 * @typedef {{ id: string, title?: string|null, projectId?: string|null, access?: string,
 * updatedAt: string, createdAt?: string, pinnedAt?: string|null, archivedAt?: string|null }} Summary
 * @param {{ history?: Summary[], metadata?: Summary[], drafts?: Summary[],
 * tasks?: { conversationId:string, input:string, createdAt:string, projectId?:string|null, access?:string, parentId?:string|null }[] }} options
 */
export function conversationList({ history = [], tasks = [], metadata = [], drafts = [] } = {}) {
  const conversations = new Map();
  for (const c of drafts) conversations.set(c.id, { ...c });
  for (const task of [...tasks]
    .filter((t) => !t.parentId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const id = task.conversationId;
    const previous = conversations.get(id);
    conversations.set(id, {
      ...previous,
      id,
      title: previous?.title || task.input.slice(0, 40),
      projectId: task.projectId || null,
      access: task.access || 'read',
      createdAt: previous?.createdAt || task.createdAt,
      updatedAt: [previous?.updatedAt || '', task.createdAt].sort().at(-1),
    });
  }
  for (const c of history) {
    const previous = conversations.get(c.id);
    conversations.set(c.id, {
      ...previous,
      ...c,
      updatedAt: [previous?.updatedAt || '', c.updatedAt].sort().at(-1),
    });
  }
  for (const c of metadata) {
    const previous = conversations.get(c.id);
    conversations.set(c.id, {
      ...c,
      ...previous,
      id: c.id,
      title: c.title || previous?.title || '新对话',
      pinnedAt: c.pinnedAt || null,
      archivedAt: c.archivedAt || null,
      updatedAt: [previous?.updatedAt || '', c.updatedAt].sort().at(-1),
    });
  }
  return [...conversations.values()].sort(compareConversations);
}
