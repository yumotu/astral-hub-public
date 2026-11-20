// Higher layers consume a back action before lower pages. One action closes one layer.
export function createBackStack() {
  const layers = new Map();
  let sequence = 0;
  return {
    register(callback, priority = 40) {
      const id = ++sequence;
      layers.set(id, { callback, priority, id });
      return () => {
        layers.delete(id);
      };
    },
    handle() {
      const ordered = [...layers.values()].sort((a, b) => b.priority - a.priority || b.id - a.id);
      for (const layer of ordered) {
        if (!layers.has(layer.id)) continue;
        try {
          if (layer.callback() !== false) return true;
        } catch {
          // Keep the current view if a guarded close fails; never fall through to exit.
          return true;
        }
      }
      return false;
    },
    get size() {
      return layers.size;
    },
  };
}
