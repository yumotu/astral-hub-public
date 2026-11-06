export const notificationLabels = {
  completed: '任务已完成',
  error: '任务需要检查',
  input: 'Pi 需要你的回复',
  plugin: 'Pi 发来一条通知',
  test: '通知测试',
};
export function notificationPayload(notice, owner, preview = false) {
  return {
    id: notice.id,
    scope: owner,
    kind: notice.kind,
    title: preview ? notice.title : '星屿',
    body: preview ? notice.body : notificationLabels[notice.kind] || '你有一条新通知',
    conversationId: notice.conversationId || null,
    taskId: notice.taskId || null,
    createdAt: notice.createdAt,
  };
}
export function notificationLink(notice) {
  const query = new URLSearchParams();
  if (/^[a-f0-9-]{36}$/.test(notice.conversationId || ''))
    query.set('piConversation', notice.conversationId);
  if (/^[a-f0-9-]{36}$/.test(notice.taskId || '')) query.set('piTask', notice.taskId);
  return query.size ? '?' + query.toString() : '';
}
