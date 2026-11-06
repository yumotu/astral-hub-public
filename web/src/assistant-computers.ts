import { useCallback, useEffect, useState } from 'react';
import { api } from './data';
import { peekAPI } from './resource-cache';
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
export type ComputerGroup = { device: ComputerDevice; projects: ComputerProject[]; error?: string };

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
  const [groups, setGroups] = useState<ComputerGroup[]>(() =>
    (peekAPI<{ devices: ComputerDevice[] }>(settings, '/relay/devices')?.devices || []).map(
      (device) => ({
        device,
        projects:
          peekAPI<{ projects: ComputerProject[] }>(
            settings,
            '/relay/projects?deviceId=' + device.id,
          )?.projects || [],
      }),
    ),
  );
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((n) => n + 1), []);
  useEffect(() => {
    if (!enabled) return;
    let live = true,
      busy = false;
    const load = async (fresh = false) => {
      if (busy) return;
      busy = true;
      try {
        const { devices } = await api<{ devices: ComputerDevice[] }>(
          settings,
          '/relay/devices',
          undefined,
          undefined,
          false,
          { fresh },
        );
        const next = await Promise.all(
          devices.map(async (device) => {
            try {
              const r = await api<{ projects: ComputerProject[] }>(
                settings,
                '/relay/projects?deviceId=' + device.id,
                undefined,
                undefined,
                false,
                { fresh },
              );
              return { device, projects: r.projects };
            } catch (e) {
              // Keep the device visible, but never substitute another device's grants.
              return { device, projects: [], error: (e as Error).message };
            }
          }),
        );
        if (live) {
          setGroups(next);
          setError('');
        }
      } catch (e) {
        if (live) setError((e as Error).message);
      } finally {
        busy = false;
        if (live) setReady(true);
      }
    };
    void load(revision > 0);
    const focus = () => {
      if (document.visibilityState === 'visible') void load(true);
    };
    const timer = setInterval(focus, 15000);
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', focus);
    window.addEventListener('astral:computer-changed', focus);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', focus);
      window.removeEventListener('astral:computer-changed', focus);
    };
  }, [settings, enabled, revision]);
  return {
    groups: groups.map((g) => ({ ...g, device: { ...g.device, local: g.device.id === localId } })),
    error,
    ready,
    refresh,
  };
}
