export type MailEntry = { value: unknown; at: number; accessed?: number; bytes?: number };
export type MailArchive = {
  load: () => Promise<Record<string, MailEntry>>;
  write: (changed: Record<string, MailEntry>, removed: string[]) => Promise<void>;
  clear: () => Promise<void>;
};
const name = 'astral-mail-archive-v1';
let database: Promise<IDBDatabase> | undefined;
function open() {
  return (database ||= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore('entries', { keyPath: 'id' }).createIndex('scope', 'scope');
    request.onerror = () => {
      database = undefined;
      reject(request.error);
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => {
        request.result.close();
        database = undefined;
      };
      resolve(request.result);
    };
  }));
}
const completed = (transaction: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () =>
      reject(transaction.error || Error('邮件缓存写入失败'));
  });
export function createMailArchive(scope: string): MailArchive | undefined {
  if (typeof indexedDB === 'undefined') return undefined;
  return {
    async load() {
      const db = await open();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction('entries'),
          request = transaction.objectStore('entries').index('scope').getAll(scope);
        request.onsuccess = () =>
          resolve(Object.fromEntries(request.result.map((r) => [r.key, r.entry])));
        request.onerror = () => reject(request.error);
      });
    },
    async write(changed, removed) {
      const db = await open(),
        transaction = db.transaction('entries', 'readwrite');
      const result = completed(transaction),
        store = transaction.objectStore('entries');
      for (const key of removed) store.delete(JSON.stringify([scope, key]));
      for (const [key, entry] of Object.entries(changed))
        store.put({ id: JSON.stringify([scope, key]), scope, key, entry });
      await result;
    },
    async clear() {
      const db = await open(),
        transaction = db.transaction('entries', 'readwrite');
      const result = completed(transaction),
        store = transaction.objectStore('entries');
      const request = store.index('scope').openKeyCursor(scope);
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          store.delete(cursor.primaryKey);
          cursor.continue();
        }
      };
      await result;
    },
  };
}
export async function clearMailArchive() {
  if (typeof indexedDB === 'undefined') return;
  const db = await open(),
    transaction = db.transaction('entries', 'readwrite');
  const result = completed(transaction);
  transaction.objectStore('entries').clear();
  await result;
}
