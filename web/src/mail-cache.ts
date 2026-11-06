// No credentials are stored here. Each server/user has an independent bounded cache.
import { createMailArchive, clearMailArchive, type MailArchive } from './mail-archive.ts';
import { defaultMailCacheSettings, mailCacheSettingsSchema } from '../../shared/mail-history.mjs';
export type MailCacheSettings = { cacheMB: number; retentionDays: number; pageSize: number };
const prefix = 'astral.mail.cache.v2:';
let epoch = 0;
export const mailTTL = {
  account: 300000,
  folders: 300000,
  list: 60000,
  body: 86400000,
  summary: 604800000,
  view: 604800000,
};
type Entry<T = unknown> = { value: T; at: number; accessed?: number; bytes?: number };
const instances = new Set<MailCache>();
export class MailCache {
  private entries: Record<string, Entry> = {};
  private born = epoch;
  private key: string;
  private storage: Storage | undefined;
  private now: () => number;
  private archive?: MailArchive;
  private hydration: Promise<void>;
  private tail = Promise.resolve();
  private written = new Map<string, Entry>();
  private settings: MailCacheSettings = { ...defaultMailCacheSettings };
  storageError = '';
  generation = 0;
  constructor(
    scope: string,
    storage: Storage | undefined = typeof localStorage === 'undefined' ? undefined : localStorage,
    now = Date.now,
    archive: MailArchive | undefined = createMailArchive(scope),
  ) {
    this.storage = storage;
    this.now = now;
    this.key = prefix + scope;
    this.archive = archive;
    instances.add(this);
    try {
      const raw = this.storage?.getItem(this.key);
      if (raw && raw.length < 1048576) {
        const saved = JSON.parse(raw);
        if (saved && typeof saved === 'object' && !Array.isArray(saved))
          this.entries = Object.fromEntries(
            Object.entries(saved).filter(
              ([, item]) =>
                item &&
                typeof item === 'object' &&
                typeof (item as Entry).at === 'number' &&
                'value' in item,
            ),
          ) as Record<string, Entry>;
      }
    } catch {
      /* Private browsing and full storage still allow an in-memory cache. */
    }
    try {
      this.settings = mailCacheSettingsSchema.parse(this.entries.preferences?.value || {});
    } catch {}
    const generation = this.generation;
    this.hydration = (async () => {
      try {
        const saved = await archive?.load();
        if (saved && this.born === epoch && generation === this.generation) {
          for (const [key, item] of Object.entries(saved)) {
            if (!item || typeof item.at !== 'number' || !('value' in item)) continue;
            this.written.set(key, item);
            if (!this.entries[key] || this.entries[key].at < item.at) this.entries[key] = item;
          }
        }
      } catch {
        this.storageError = '此设备无法保存长期邮件缓存，当前使用临时缓存。';
      }
    })();
  }
  ready() {
    return this.hydration;
  }
  flush() {
    return this.tail;
  }
  configure(settings: MailCacheSettings) {
    this.settings = mailCacheSettingsSchema.parse(settings);
    this.entries.preferences = { value: this.settings, at: this.now(), accessed: this.now() };
    this.persist();
  }
  dispose() {
    instances.delete(this);
  }
  get<T>(key: string, ttl: number): (Entry<T> & { stale: boolean }) | null {
    const hit = this.entries[key];
    if (this.born !== epoch || !hit || typeof hit.at !== 'number' || !('value' in hit)) return null;
    if (
      !['account', 'preferences', 'view'].includes(key) &&
      this.settings.retentionDays &&
      this.now() - (hit.accessed ?? hit.at) >= this.settings.retentionDays * 86400000
    )
      return null;
    this.entries[key] = { ...hit, accessed: this.now() };
    return { ...hit, value: hit.value as T, stale: this.now() - hit.at >= ttl };
  }
  set(key: string, value: unknown, generation = this.generation) {
    if (this.born !== epoch || generation !== this.generation) return;
    this.entries[key] = {
      value,
      at: this.now(),
      accessed: this.now(),
      bytes: new TextEncoder().encode(JSON.stringify(value)).length + key.length * 2 + 128,
    };
    this.persist();
  }
  invalidateMailbox(mailbox: string) {
    this.generation++;
    for (const key of Object.keys(this.entries)) {
      try {
        const parts = JSON.parse(key);
        if (Array.isArray(parts) && parts[1] === mailbox) delete this.entries[key];
      } catch {}
    }
    this.persist();
  }
  applySeen(mailbox: string, uids: number[], seen: boolean) {
    if (this.born !== epoch) return;
    const selected = new Set(uids);
    for (const [key, entry] of Object.entries(this.entries)) {
      try {
        const parts = JSON.parse(key);
        if (parts[0] !== 'list' || parts[1] !== mailbox) continue;
        const page = entry.value as { messages?: { uid: number; seen: boolean }[] };
        const rows = (Array.isArray(entry.value) ? entry.value : page?.messages) as {
          uid: number;
          seen: boolean;
        }[];
        if (!Array.isArray(rows)) continue;
        const updated = rows
          .filter((row) => !(parts[3] && seen && selected.has(row.uid)))
          .map((row) => (selected.has(row.uid) ? { ...row, seen } : row));
        this.entries[key] = {
          ...entry,
          bytes: undefined,
          value: Array.isArray(entry.value) ? updated : { ...page, messages: updated },
        };
      } catch {}
    }
    // Counts are refreshed from the provider; bodies and reply drafts stay cached.
    delete this.entries.folders;
    this.persist();
  }
  invalidateLists() {
    this.generation++;
    for (const key of Object.keys(this.entries)) {
      try {
        if (JSON.parse(key)[0] === 'list') delete this.entries[key];
      } catch {}
    }
    delete this.entries.folders;
    this.persist();
  }
  private persist() {
    if (this.born !== epoch) return;
    const rows = Object.entries(this.entries).sort(
      (a, b) => (b[1].accessed ?? b[1].at) - (a[1].accessed ?? a[1].at),
    );
    let bytes = 0,
      count = 0;
    for (const [key, entry] of rows) {
      entry.bytes ??=
        new TextEncoder().encode(JSON.stringify(entry.value)).length + key.length * 2 + 128;
      if (
        count >= 20000 ||
        bytes + entry.bytes > this.settings.cacheMB * 1048576 ||
        (!['account', 'preferences', 'view'].includes(key) &&
          this.settings.retentionDays &&
          this.now() - (entry.accessed ?? entry.at) >= this.settings.retentionDays * 86400000)
      )
        delete this.entries[key];
      else {
        bytes += entry.bytes;
        count++;
      }
    }
    const quick: Record<string, Entry> = {};
    let quickBytes = 2;
    for (const [key, entry] of rows) {
      if (!this.entries[key]) continue;
      if (quickBytes + entry.bytes! > 1000000) continue;
      const size = JSON.stringify([key, entry]).length + 2;
      if (quickBytes + size < 1000000) {
        quick[key] = entry;
        quickBytes += size;
      }
    }
    const serialized = JSON.stringify(quick);
    try {
      this.storage?.setItem(this.key, serialized);
    } catch {
      /* Keep memory fallback. */
    }
    if (this.archive) {
      const snapshot = { ...this.entries },
        born = this.born;
      this.tail = this.tail
        .then(async () => {
          await this.hydration;
          if (born !== epoch) return;
          const changed = Object.fromEntries(
            Object.entries(snapshot).filter(([key, value]) => this.written.get(key) !== value),
          );
          const removed = [...this.written.keys()].filter((key) => !snapshot[key]);
          await this.archive!.write(changed, removed);
          this.written = new Map(Object.entries(snapshot));
        })
        .catch(() => {
          this.storageError = '此设备的长期缓存写入失败，可能已达到存储空间上限。';
        });
    }
  }
  clear() {
    this.generation++;
    this.entries = {};
    if (this.archive)
      this.tail = this.tail
        .then(() => this.archive!.clear())
        .then(() => {
          this.written.clear();
        })
        .catch(() => {});
    try {
      this.storage?.removeItem(this.key);
    } catch {}
  }
}
export function clearMailCaches(
  storage: Storage | undefined = typeof localStorage === 'undefined' ? undefined : localStorage,
) {
  epoch++;
  for (const cache of instances) cache.clear();
  instances.clear();
  void clearMailArchive().catch(() => {});
  try {
    for (let i = (storage?.length || 0) - 1; i >= 0; i--) {
      const key = storage!.key(i);
      if (key?.startsWith('astral.mail.cache.')) storage!.removeItem(key);
    }
  } catch {}
}
