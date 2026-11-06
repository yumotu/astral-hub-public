import { useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { nativeAppearance } from './native-appearance';
import { LocalNotifications } from '@capacitor/local-notifications';
import { confirmNativeDelivery } from '../../shared/native-notification-delivery.mjs';
import { api } from './data';
import { notificationPayload } from '../../shared/notifications.mjs';
import {
  notificationDelivery,
  deliverNotificationBatch,
} from '../../shared/notification-client.mjs';
import {
  deliverWebNotification,
  clearWebNotificationScope,
} from '../../shared/web-notification-delivery.mjs';
import type { Settings } from './types';
export type AppNotification = {
  id: string;
  seq: number;
  kind: string;
  title: string;
  body: string;
  conversationId?: string | null;
  taskId?: string | null;
  createdAt: string;
  readAt: string | null;
};
type Prefs = { enabled: boolean; preview: boolean; onlyBackground: boolean; deviceId: string };
type ServerStatus = {
  scope: string;
  publicKey: string;
  webPush: boolean;
  androidRemotePush: boolean;
  devices: { id: string; delivery: string | null; error: string; remote: boolean }[];
};
const platform = () =>
  Capacitor.isNativePlatform() ? 'android' : window.astralDesktop ? 'desktop' : 'web';
const permissionWait =
  '系统授权尚未完成。请在浏览器或系统设置中允许通知后重试；通知记录仍保存在通知中心。';
function stored(key: string, fallback: unknown): any {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback;
  } catch {
    return fallback;
  }
}
function readPrefs(key: string): Prefs {
  const value = stored(key, {});
  return {
    deviceId: typeof value?.deviceId === 'string' ? value.deviceId : crypto.randomUUID(),
    enabled: value?.enabled === true,
    preview: value?.preview === true,
    onlyBackground: value?.onlyBackground !== false,
  };
}
async function bounded<T>(pending: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
async function worker() {
  if (!isSecureContext || !('serviceWorker' in navigator))
    throw new Error('当前浏览器不支持后台通知；可使用 HTTPS 或 localhost 地址。');
  await bounded(
    navigator.serviceWorker.register('./notifications-sw.js'),
    8000,
    '通知服务注册超时。',
  );
  return bounded(navigator.serviceWorker.ready, 8000, '通知服务启动超时。');
}
async function workerMessage(data: Record<string, unknown>) {
  const registration = await worker();
  return new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => reject(new Error('通知服务未响应。')), 6000);
    channel.port1.onmessage = (e) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(e.data);
    };
    registration.active?.postMessage(data, [channel.port2]);
  });
}
function keyBytes(value: string) {
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (c) =>
    c.charCodeAt(0),
  );
}
async function permission(request = false) {
  if (platform() === 'android')
    return (
      await (request
        ? LocalNotifications.requestPermissions()
        : LocalNotifications.checkPermissions())
    ).display;
  if (platform() === 'desktop')
    return (await window.astralDesktop!.notifications.supported()) ? 'system' : 'unsupported';
  if (!('Notification' in window)) return 'unsupported';
  return request ? Notification.requestPermission() : Notification.permission;
}
export function useNotifications(
  settings: Settings,
  owner: string | undefined,
  onOpen: (n: { conversationId?: string | null; taskId?: string | null }) => void,
) {
  const storageKey = `astral.notifications:${settings.url}:${owner || 'guest'}`;
  const [prefs, setPrefs] = useState<Prefs>(() => readPrefs(storageKey));
  const [items, setItems] = useState<AppNotification[]>([]),
    [unread, setUnread] = useState(0),
    [server, setServer] = useState<ServerStatus | null>(null);
  const [systemPermission, setPermission] = useState('unknown'),
    [delivery, setDelivery] = useState(''),
    [pushWarning, setPushWarning] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [readingAll, setReadingAll] = useState(false);
  const inboxCursor = useRef(0);
  const live = useRef({ settings, owner, onOpen, prefs });
  live.current = { settings, owner, onOpen, prefs };
  const mounted = useRef(true);
  const registrations = useRef(0);
  const transport = useRef<{ key: string; deliver: (n: AppNotification) => Promise<any> } | null>(
    null,
  );
  if (transport.current?.key !== storageKey) {
    const seen = stored(storageKey + ':seen', []);
    transport.current = {
      key: storageKey,
      deliver: notificationDelivery({
        seen: Array.isArray(seen) ? seen.filter((id) => typeof id === 'string') : [],
        deliver: (n: AppNotification) => show(n, owner || ''),
        persist: (ids: string[]) => {
          try {
            localStorage.setItem(storageKey + ':seen', JSON.stringify(ids));
          } catch {}
        },
      }),
    };
  }
  useEffect(() => {
    const next = readPrefs(storageKey);
    live.current.prefs = next;
    setPrefs(next);
    setItems([]);
    setUnread(0);
    setServer(null);
    setError('');
    setDelivery('');
    setPushWarning('');
    setBusy(false);
    setReadingAll(false);
    inboxCursor.current = 0;
    setPermission('unknown');
  }, [storageKey]);
  function save(next: Prefs) {
    live.current.prefs = next;
    setPrefs(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      setError('设备设置未能持久保存。');
    }
  }
  async function refresh() {
    const current = live.current;
    if (!current.owner) return;
    const result = await api<{ notifications: AppNotification[]; unread: number; cursor: number }>(
      current.settings,
      '/notifications',
    );
    if (
      mounted.current &&
      live.current.owner === current.owner &&
      live.current.settings.url === current.settings.url &&
      live.current.settings.sessionToken === current.settings.sessionToken
    ) {
      setItems(result.notifications);
      setUnread(result.unread);
      inboxCursor.current = result.cursor;
    }
  }
  async function register(next: Prefs, subscribe = false) {
    const context = live.current;
    const revision = ++registrations.current;
    const active = () =>
      revision === registrations.current &&
      mounted.current &&
      live.current.owner === context.owner &&
      live.current.settings.url === context.settings.url &&
      live.current.settings.sessionToken === context.settings.sessionToken;
    const status = await api<ServerStatus>(context.settings, '/notifications/status');
    if (!active()) return;
    setServer(status);
    let subscription: unknown;
    if (platform() === 'web' && next.enabled) {
      try {
        const registration = await worker();
        if (!active()) return;
        await workerMessage({
          type: 'ASTRAL_BIND',
          scope: status.scope,
          onlyBackground: next.onlyBackground,
        });
        if (!active()) {
          if (live.current.owner !== context.owner)
            await workerMessage({ type: 'ASTRAL_CLEAR', scope: status.scope });
          return;
        }
        let sub = registration.pushManager
          ? await registration.pushManager.getSubscription()
          : null;
        if (!sub && subscribe && registration.pushManager)
          sub = await bounded(
            registration.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: keyBytes(status.publicKey).buffer,
            }),
            15000,
            '浏览器推送服务未响应。',
          );
        subscription = sub?.toJSON();
      } catch {
        if (active()) setPushWarning('后台 Web Push 暂不可用；网页打开期间使用本机通知通道。');
      }
    }
    if (!active()) return;
    await api(context.settings, '/notifications/devices', {
      id: next.deviceId,
      platform: platform(),
      enabled: next.enabled,
      preview: next.preview,
      ...(subscription ? { subscription } : {}),
    });
    const updated = await api<ServerStatus>(context.settings, '/notifications/status');
    if (active()) setServer(updated);
  }
  async function show(n: AppNotification, expectedOwner: string) {
    const current = live.current;
    const active = () =>
      mounted.current &&
      live.current.owner === expectedOwner &&
      live.current.settings.url === current.settings.url &&
      live.current.settings.sessionToken === current.settings.sessionToken &&
      live.current.prefs.enabled;
    if (!current.prefs.enabled || current.owner !== expectedOwner) return { mode: 'ignored' };
    if (
      current.prefs.onlyBackground &&
      document.visibilityState === 'visible' &&
      document.hasFocus() &&
      !['test', 'plugin'].includes(n.kind)
    )
      return { mode: 'suppressed' };
    const allowed = await permission();
    if (!active()) return { mode: 'ignored' };
    setPermission(allowed);
    if (!['granted', 'system'].includes(allowed))
      throw new Error('本机系统通知权限未开启，请点击「开启或修复通知」并允许通知。');
    const data = notificationPayload(n, current.owner, current.prefs.preview);
    if (platform() === 'desktop') {
      const result = await window.astralDesktop!.notifications.show(data);
      if (!result.ok) throw new Error(result.error || '系统未展示通知。');
    } else if (platform() === 'android') {
      let id = 0;
      for (const c of n.id) id = (id * 31 + c.charCodeAt(0)) >>> 0;
      await LocalNotifications.createChannel({
        id: 'astral-tasks',
        name: '星屿任务通知',
        importance: 4,
        visibility: 0,
        vibration: true,
      });
      const channels = await LocalNotifications.listChannels();
      if (!active()) return { mode: 'ignored' };
      if (channels.channels.find((c) => c.id === 'astral-tasks')?.importance === 0)
        throw new Error('「星屿任务通知」类别已关闭，请在 Android 通知设置中开启。');
      const notificationId = (id % 2147483646) + 1;
      await LocalNotifications.schedule({
        notifications: [
          {
            id: notificationId,
            title: data.title,
            body: data.body,
            channelId: 'astral-tasks',
            smallIcon: 'ic_stat_astral',
            largeIcon: 'ic_notification_astral',
            iconColor: '#5263e7',
            extra: data,
          },
        ],
      });
      const delivered = await confirmNativeDelivery({
        read: () => LocalNotifications.getDeliveredNotifications(),
        id: notificationId,
        active,
      });
      if (delivered.mode === 'ignored') return delivered;
      setDelivery(`Android 通知栏已收到 · ${new Date().toLocaleTimeString()}`);
    } else {
      const result = await deliverWebNotification(data, {
        workerSend: workerMessage,
        Notification: window.Notification,
        active,
        onClick: () => {
          window.focus();
          live.current.onOpen(data);
        },
        onlyBackground: current.prefs.onlyBackground,
      });
      if (result.mode !== 'ignored')
        setDelivery(
          `浏览器已接受通知展示 · ${new Date().toLocaleTimeString()}${result.mode === 'page' ? ' · 网页直达通道' : ''}`,
        );
      return result;
    }
    return { mode: platform() };
  }
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    const controller = new AbortController();
    if (!owner)
      return () => {
        mounted.current = false;
      };
    void permission().then((value) => {
      if (!cancelled) setPermission(value);
    });
    void api<ServerStatus>(settings, '/notifications/status')
      .then((value) => {
        if (!cancelled) setServer(value);
      })
      .catch(() => {});
    const open = (n: { scope?: string; conversationId?: string; taskId?: string }) => {
      if (n.scope === owner) live.current.onOpen(n);
    };
    const message = (e: MessageEvent) => {
      if (e.data?.type === 'ASTRAL_OPEN_NOTIFICATION') open(e.data);
    };
    navigator.serviceWorker?.addEventListener('message', message);
    const removeDesktop = window.astralDesktop?.notifications.onClick(open);
    const removeAndroid =
      platform() === 'android'
        ? LocalNotifications.addListener('localNotificationActionPerformed', (e) =>
            open(e.notification.extra || {}),
          )
        : null;
    if (live.current.prefs.enabled)
      void register(live.current.prefs).catch((e) => {
        if (!cancelled) setError(e.message);
      });
    let after = Number(stored(storageKey + ':cursor', 0));
    if (!Number.isSafeInteger(after) || after < 0) after = 0;
    const deliveryTransport = transport.current!;
    const syncPermission = () => {
      void permission()
        .then((p) => {
          if (!cancelled) {
            setPermission(p);
            if (['granted', 'system'].includes(p))
              setError((value) => (value === permissionWait ? '' : value));
          }
        })
        .catch(() => {});
    };
    let permissionStatus: PermissionStatus | undefined;
    if (platform() === 'web' && navigator.permissions?.query)
      void navigator.permissions
        .query({ name: 'notifications' })
        .then((value) => {
          if (cancelled) return;
          permissionStatus = value;
          value.addEventListener('change', syncPermission);
        })
        .catch(() => {});
    window.addEventListener('focus', syncPermission);
    document.addEventListener('visibilitychange', syncPermission);
    void (async () => {
      try {
        const initial = await api<{
          notifications: AppNotification[];
          cursor: number;
          unread: number;
        }>(settings, '/notifications');
        if (cancelled) return;
        setItems(initial.notifications);
        setUnread(initial.unread);
        inboxCursor.current = initial.cursor;
        if (!after) {
          after = initial.cursor;
          localStorage.setItem(storageKey + ':cursor', String(after));
        }
      } catch {}
      while (!cancelled) {
        try {
          const result = await api<{ notifications: AppNotification[]; cursor: number }>(
            settings,
            `/notifications/updates?after=${after}`,
            undefined,
            undefined,
            false,
            { signal: controller.signal, timeout: 30000 },
          );
          if (cancelled) break;
          if (result.notifications.length) void refresh().catch(() => {});
          await deliverNotificationBatch(result.notifications, {
            deliver: deliveryTransport.deliver,
            active: () => !cancelled && live.current.owner === owner,
            acknowledge: (seq: number) => {
              after = seq;
              localStorage.setItem(storageKey + ':cursor', String(after));
            },
          });
          if (!cancelled) await refresh();
        } catch (e) {
          if (!cancelled) setError((e as Error).message);
          if (!cancelled)
            await new Promise((resolve) => {
              const done = () => {
                clearTimeout(timer);
                controller.signal.removeEventListener('abort', done);
                resolve(null);
              };
              const timer = setTimeout(done, 5000);
              controller.signal.addEventListener('abort', done, { once: true });
            });
        }
      }
    })();
    return () => {
      cancelled = true;
      mounted.current = false;
      controller.abort();
      window.removeEventListener('focus', syncPermission);
      document.removeEventListener('visibilitychange', syncPermission);
      permissionStatus?.removeEventListener('change', syncPermission);
      navigator.serviceWorker?.removeEventListener('message', message);
      removeDesktop?.();
      void removeAndroid?.then((h) => h.remove());
      if (platform() === 'web') if (live.current.owner !== owner) clearWebNotificationScope(owner);
      if (platform() === 'web')
        void navigator.serviceWorker
          ?.getRegistration()
          .then((r) => {
            if (live.current.owner !== owner)
              r?.active?.postMessage({ type: 'ASTRAL_CLEAR', scope: owner });
          })
          .catch(() => {});
    };
  }, [owner, settings.url, settings.sessionToken]);
  async function enable() {
    const context = live.current;
    if (!context.owner) return false;
    const active = () =>
      mounted.current &&
      live.current.owner === context.owner &&
      live.current.settings.url === context.settings.url &&
      live.current.settings.sessionToken === context.settings.sessionToken;
    setBusy(true);
    setError('');
    try {
      const granted = await bounded(permission(true), 30000, permissionWait);
      if (!active()) return false;
      setPermission(granted);
      if (!['granted', 'system'].includes(granted))
        throw new Error('请在系统或浏览器设置中允许星屿通知。');
      const next = { ...prefs, enabled: true };
      save(next);
      // Register live delivery first; optional Web Push must not hold up a test.
      await register(next);
      if (platform() === 'web')
        void register(next, true).catch((e) => {
          if (active()) setError(e.message);
        });
      return active();
    } catch (e) {
      if (active()) setError((e as Error).message);
      return false;
    } finally {
      if (active()) setBusy(false);
    }
  }
  async function update(patch: Partial<Prefs>) {
    const next = { ...prefs, ...patch };
    save(next);
    setError('');
    try {
      await register(next);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function test() {
    setError('');
    setDelivery('');
    try {
      if (!live.current.prefs.enabled || !['granted', 'system'].includes(await permission())) {
        if (!(await enable())) return;
      }
      const context = live.current;
      const channel = transport.current!;
      setDelivery('正在投递测试通知…');
      const result = await api<{ notification: AppNotification }>(
        context.settings,
        '/notifications/test',
        { id: crypto.randomUUID() },
      );
      if (live.current.owner !== context.owner || channel !== transport.current) return;
      await channel.deliver(result.notification);
      await refresh();
    } catch (e) {
      setDelivery('测试通知未送达，请查看下方原因。');
      setError((e as Error).message);
    }
  }
  async function openSystemSettings() {
    try {
      await nativeAppearance.openNotificationSettings();
    } catch {
      setError('请在手机系统设置中打开「应用 → 星屿 → 通知」，允许通知及横幅。');
    }
  }
  async function open(n: AppNotification) {
    try {
      await api(settings, `/notifications/${n.id}/read`, {});
      await refresh();
    } catch {}
    live.current.onOpen(n);
  }
  async function readAll() {
    if (readingAll) return;
    const context = live.current,
      through = inboxCursor.current;
    if (!context.owner) return;
    const active = () =>
      mounted.current &&
      live.current.owner === context.owner &&
      live.current.settings.url === context.settings.url &&
      live.current.settings.sessionToken === context.settings.sessionToken;
    setReadingAll(true);
    try {
      await api(context.settings, '/notifications/read-all', { through });
      if (active()) await refresh();
    } catch (e) {
      if (active()) setError((e as Error).message);
    } finally {
      if (active()) setReadingAll(false);
    }
  }
  return {
    items,
    unread,
    prefs,
    server,
    systemPermission,
    error,
    delivery,
    pushWarning,
    busy,
    readingAll,
    readAll,
    enable,
    update,
    test,
    openSystemSettings,
    open,
    refresh,
    platform: platform(),
    signedIn: !!owner,
  };
}
export type NotificationModel = ReturnType<typeof useNotifications>;
