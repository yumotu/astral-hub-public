// Transactional test store. Native cross-tab behavior is also verified in Chrome.
export function preparationIDB() {
  const records = new Map();
  let tail = Promise.resolve(),
    failure;
  const db = {
    transaction() {
      let release,
        aborted = false,
        staged;
      const previous = tail;
      tail = new Promise((resolve) => {
        release = resolve;
      });
      const tx = {
        abort() {
          aborted = true;
        },
        objectStore() {
          return {
            get(key) {
              const request = {};
              previous.then(() => {
                staged = new Map(records);
                request.result = structuredClone(records.get(key));
                request.onsuccess();
                if (failure) {
                  tx.error = failure;
                  failure = undefined;
                  aborted = true;
                }
                if (aborted) tx.onabort();
                else {
                  records.clear();
                  for (const [k, v] of staged) records.set(k, v);
                  tx.oncomplete();
                }
                release();
              });
              return request;
            },
            put(value, key) {
              staged.set(key, structuredClone(value));
            },
          };
        },
      };
      return tx;
    },
  };
  return {
    factory: {
      open() {
        const request = { result: db };
        queueMicrotask(() => request.onsuccess());
        return request;
      },
    },
    failNext(error = Error('transaction aborted')) {
      failure = error;
    },
    reset() {
      records.clear();
      failure = undefined;
    },
  };
}
