// Read flags are reversible and do not need a second user confirmation. Retain
// the server's exact UID/UIDVALIDITY audit and query a lost receipt, never replay.
export async function applyMailReadFlag(request, operation) {
  if (!['read', 'unread'].includes(operation.action)) throw Error('此入口只修改已读状态。');
  const prepared = await request('/mail/actions/prepare', operation);
  let result;
  try {
    result = await request('/mail/actions/' + prepared.id + '/confirm', { confirm: true });
  } catch (error) {
    try {
      result = await request('/mail/actions/' + prepared.id, undefined, true);
    } catch {
      throw Error('已读状态回执未确认，请刷新邮箱核对；未重复操作。');
    }
    if (result.state !== 'done')
      throw Error(result.error || '已读状态未确认，请刷新邮箱核对；未重复操作。');
  }
  if (result.state !== 'done') throw Error(result.error || '邮箱未确认已读状态，请刷新核对。');
  return result;
}
