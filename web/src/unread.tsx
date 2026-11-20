import { useEffect, useState } from 'react';
import { api } from './data';
import { peekAPI, resourceScope, setAPICache } from './resource-cache';
import type { Settings } from './types';
type SocialUnread = { messages: number; requests: number };
type MailUnread = { configured: boolean; available: boolean; count: number | null };
type Snapshot = { scope: string; social?: SocialUnread; mail?: MailUnread };
export function useUnread(settings: Settings, signedIn: boolean) {
  const scope = resourceScope(settings);
  const initial = (): Snapshot => ({
    scope,
    social: peekAPI(settings, '/social/unread'),
    mail: peekAPI(settings, '/mail/unread'),
  });
  const [snapshot, setSnapshot] = useState<Snapshot>(initial);
  useEffect(() => {
    let live = true,
      socialBusy = false,
      mailBusy = false;
    const controller = new AbortController();
    setSnapshot(initial());
    if (!signedIn) return () => controller.abort();
    const social = async () => {
      if (socialBusy || document.visibilityState === 'hidden') return;
      socialBusy = true;
      try {
        const value = await api<SocialUnread>(
          settings,
          '/social/unread',
          undefined,
          undefined,
          false,
          { signal: controller.signal, timeout: 15000 },
        );
        if (live) {
          setAPICache(settings, '/social/unread', value);
          setSnapshot((s) => ({ ...s, scope, social: value }));
        }
      } catch {
      } finally {
        socialBusy = false;
      }
    };
    const mail = async () => {
      if (mailBusy || document.visibilityState === 'hidden') return;
      mailBusy = true;
      try {
        const value = await api<MailUnread>(settings, '/mail/unread', undefined, undefined, false, {
          signal: controller.signal,
          timeout: 45000,
        });
        if (live) {
          if (value.available) setAPICache(settings, '/mail/unread', value);
          setSnapshot((s) => ({
            ...s,
            scope,
            mail: value.available ? value : s.mail ? { ...s.mail, available: false } : value,
          }));
        }
      } catch {
        if (live)
          setSnapshot((s) => ({
            ...s,
            scope,
            mail: s.mail ? { ...s.mail, available: false } : undefined,
          }));
      } finally {
        mailBusy = false;
      }
    };
    const refresh = () => {
      void social();
      void mail();
    };
    refresh();
    const st = setInterval(() => void social(), 10000),
      mt = setInterval(() => void mail(), 60000);
    window.addEventListener('astral:unread-change', refresh);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      live = false;
      controller.abort();
      clearInterval(st);
      clearInterval(mt);
      window.removeEventListener('astral:unread-change', refresh);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [scope, signedIn]);
  return (snapshot.scope === scope && signedIn ? snapshot : { scope }) as Snapshot;
}
export function UnreadBadge({ count, label }: { count: number | undefined; label: string }) {
  return count && count > 0 ? (
    <span className="unread-count" aria-label={`${count} ${label}`}>
      {count > 99 ? '99+' : count}
    </span>
  ) : null;
}
