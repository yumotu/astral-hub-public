import { clearResourceCaches } from './resource-cache.ts';
import type { Settings, User, AuthSession } from './types';
import { clearMailCaches } from './mail-cache.ts';
export function serverIdentity(s: Pick<Settings, 'url'>) {
  return s.url.replace(/\/$/, '') || (typeof location !== 'undefined' ? location.origin : 'local');
}
export function loadSession(s: Settings): AuthSession | null {
  try {
    const raw = sessionStorage.getItem('astral.account') || localStorage.getItem('astral.account');
    if (!raw) return null;
    const a = JSON.parse(raw);
    return a.server === serverIdentity(s) &&
      typeof a.token === 'string' &&
      a.token.length > 30 &&
      typeof a.user?.id === 'string' &&
      Date.parse(a.expiresAt) > Date.now()
      ? a
      : null;
  } catch {
    return null;
  }
}
export function persistSession(a: AuthSession | null) {
  if (!a || loadSession({ url: a.server } as Settings)?.user.id !== a.user.id) {
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('astral:account-reset'));
    clearMailCaches();
    clearResourceCaches();
  }
  sessionStorage.removeItem('astral.account');
  localStorage.removeItem('astral.account');
  if (a) (a.remember ? localStorage : sessionStorage).setItem('astral.account', JSON.stringify(a));
}
export async function endSession(revoke: () => Promise<unknown>, clear: () => void) {
  // Local logout must work even after expiry, remote revocation or a network outage.
  clear();
  try {
    await revoke();
    return true;
  } catch {
    return false;
  }
}
export function accountScope(s: Settings, a: AuthSession | null) {
  return (
    encodeURIComponent(serverIdentity(s)) +
    ':' +
    (a?.user.role === 'owner' ? 'legacy' : a?.user.id || (s.token ? 'legacy' : 'guest'))
  );
}
export function userLabel(u: User) {
  return u.displayName || u.username;
}
