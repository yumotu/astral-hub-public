import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './data';
import { peekAPI, resourceScope, setAPICache, warmResourceCache } from './resource-cache';
import {
  readComputerCatalogueCache,
  refreshComputerCatalogue,
} from '../../shared/computer-catalogue.mjs';
import type { Settings } from './types';
import type { ComputerProject } from './computer-api';

export type ComputerDevice = {
  id: string;
  name: string;
  online: boolean;
  lastSeen: string;
  agentVersion?: string | null;
  capabilities?: string[];
  local?: boolean;
};
export type ComputerTarget = {
  deviceId: string;
  projectId: string;
  conversationId: string;
  panel?: 'files' | 'terminal' | 'plugins';
};
export type ComputerGroup = {
  device: ComputerDevice;
  projects: ComputerProject[];
  error?: string;
  verified?: boolean;
  loading?: boolean;
};

export function useAssistantComputers(settings: Settings, enabled: boolean, owner?: string) {
  const [localId, setLocalId] = useState('');
  useEffect(() => {
    const bridge = window.astralDesktop?.computer;
    if (!bridge || !enabled || !owner) {
      setLocalId('');
      return;
    }
    let live = true;
    const read = () =>
      void bridge
        .status({ server: settings.url || location.origin, owner })
        .then((s) => {
          if (live) setLocalId(s.deviceId || '');
        })
        .catch(() => {
          if (live) setLocalId('');
        });
    read();
    window.addEventListener('astral:computer-changed', read);
    return () => {
      live = false;
      window.removeEventListener('astral:computer-changed', read);
    };
  }, [settings.url, enabled, owner]);
  const scope = JSON.stringify([resourceScope(settings), owner || '']);
  type CatalogueState = {
    scope: string;
    groups: ComputerGroup[];
    error: string;
    ready: boolean;
    refreshing: boolean;
  };
  const [state, setState] = useState<CatalogueState>(() => ({
    scope,
    groups: readComputerCatalogueCache((path) => peekAPI(settings, path)),
    error: '',
    ready: false,
    refreshing: enabled,
  }));
  const latest = useRef(state);
  latest.current = state;
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((n) => n + 1), []);
  useEffect(() => {
    if (!enabled) {
      setState({ scope, groups: [], error: '', ready: false, refreshing: false });
      return;
    }
    const controller = new AbortController();
    let live = true,
      busy = false;
    const update = (changes: Partial<CatalogueState>) => {
      if (!live) return;
      const current = latest.current;
      const next = {
        ...(current.scope === scope
          ? current
          : { scope, groups: [], error: '', ready: false, refreshing: true }),
        ...changes,
      };
      latest.current = next;
      setState(next);
    };
    const load = async () => {
      if (!live || busy) return;
      busy = true;
      update({ refreshing: true });
      try {
        await warmResourceCache(settings);
        if (!live) return;
        const current = latest.current;
        const seed =
          current.scope === scope && current.groups.length
            ? current.groups
            : readComputerCatalogueCache((path) => peekAPI(settings, path));
        update({ groups: seed });
        await refreshComputerCatalogue({
          seed,
          signal: controller.signal,
          active: () => live,
          read: async (path) => {
            const value = await api(settings, path, undefined, undefined, false, {
              fresh: true,
              signal: controller.signal,
              timeout: 8000,
            });
            if (live) setAPICache(settings, path, value);
            return value;
          },
          onChange: (groups) => update({ groups, error: '', ready: true }),
        });
      } catch (e) {
        update({ error: (e as Error).message });
      } finally {
        busy = false;
        update({ ready: true, refreshing: false });
      }
    };
    void load();
    const focus = () => {
      if (document.visibilityState === 'visible') void load();
    };
    const timer = setInterval(focus, 15000);
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', focus);
    window.addEventListener('astral:computer-changed', focus);
    return () => {
      live = false;
      controller.abort();
      clearInterval(timer);
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', focus);
      window.removeEventListener('astral:computer-changed', focus);
    };
  }, [scope, enabled, revision]);
  const visible = enabled && state.scope === scope;
  return {
    groups: visible
      ? state.groups.map((g) => ({ ...g, device: { ...g.device, local: g.device.id === localId } }))
      : [],
    error: visible ? state.error : '',
    ready: visible && state.ready,
    refreshing: enabled && (!visible || state.refreshing),
    refresh,
  };
}
