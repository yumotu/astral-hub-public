// Window-scoped drafts never contain selected quotes, permissions or main history.
export const temporaryChatDraftKey = (server, owner, conversation) =>
  'astral.temporary.draft:' + JSON.stringify([server, owner, conversation]);
export const temporaryChatHours = [1, 6, 24, 168];
export function saveTemporaryDraft(storage, key, input, expiresAt) {
  try {
    if (!input || (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())))
      storage.removeItem(key);
    else storage.setItem(key, JSON.stringify({ input, expiresAt }));
  } catch {
    /* The composer remains usable when window storage is unavailable. */
  }
}
export function readTemporaryDraft(storage, key, now = Date.now()) {
  try {
    const value = JSON.parse(storage.getItem(key) || 'null');
    if (
      !value ||
      typeof value.input !== 'string' ||
      value.input.length > 1800 ||
      (value.expiresAt !== null && (!Number.isFinite(value.expiresAt) || value.expiresAt <= now))
    ) {
      storage.removeItem(key);
      return '';
    }
    return value.input;
  } catch {
    try {
      storage.removeItem(key);
    } catch {}
    return '';
  }
}
/** @param {{conversationId:string, expiresAt:number|null}|null} liveSession */
export function clearExpiredTemporaryDrafts(
  storage,
  server,
  owner,
  expiredIds = [],
  now = Date.now(),
  liveSession = null,
) {
  const prefix = 'astral.temporary.draft:';
  try {
    // Opening the same server-confirmed session renews its idle window. A
    // different device or a protected long-running task may have outlived the
    // local deadline, so adopt the authoritative lifetime before local cleanup.
    // Explicitly expired IDs always win and cannot be restored this way.
    if (
      typeof liveSession?.conversationId === 'string' &&
      !expiredIds.includes(liveSession.conversationId) &&
      (liveSession.expiresAt === null ||
        (Number.isFinite(liveSession.expiresAt) && liveSession.expiresAt > now))
    ) {
      try {
        const key = temporaryChatDraftKey(server, owner, liveSession.conversationId);
        const value = JSON.parse(storage.getItem(key) || 'null');
        if (
          value &&
          typeof value.input === 'string' &&
          value.input.length <= 1800 &&
          (value.expiresAt === null || Number.isFinite(value.expiresAt))
        )
          storage.setItem(
            key,
            JSON.stringify({ input: value.input, expiresAt: liveSession.expiresAt }),
          );
      } catch {
        /* Malformed current input cannot prevent confirmed expiry cleanup. */
      }
    }
    const keys = Array.from({ length: storage.length }, (_, i) => storage.key(i));
    for (const key of keys) {
      if (!key?.startsWith(prefix)) continue;
      let scope;
      try {
        scope = JSON.parse(key.slice(prefix.length));
      } catch {
        continue;
      }
      if (!Array.isArray(scope) || scope[0] !== server || scope[1] !== owner) continue;
      if (expiredIds.includes(scope[2])) storage.removeItem(key);
      else readTemporaryDraft(storage, key, now);
    }
  } catch {
    /* No browsing or cross-account storage cleanup. */
  }
}
