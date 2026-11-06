import { useMemo, useSyncExternalStore } from 'react';
import { createMessageOutbox } from '../../shared/message-outbox.mjs';
import { api } from './data';
import { resourceScope } from './resource-cache';
import { serverIdentity } from './session';
import type { Settings } from './types';
import type { PiTask } from './pi-tasks';
import type { ChatFile } from './ChatFiles';
export type OutboxRow = {
  payload: {
    id: string;
    conversationId: string;
    input: string;
    projectId: string | null;
    access: 'read' | 'edit';
    thinkingLevel: string;
    attachments: string[];
    mode: 'queue' | 'steer';
    parentId: string | null;
    deliveryPreference?: 'queue' | 'steer';
    deviceId?: string;
    execute?: boolean;
  };
  files: ChatFile[];
  status: 'queued' | 'sending' | 'accepted' | 'unknown' | 'rejected';
  error: string;
  createdAt: string;
  receipt?: { task: PiTask };
};
const managers = new Map<string, ReturnType<typeof createMessageOutbox>>();
if (typeof window !== 'undefined')
  window.addEventListener('astral:account-reset', () => {
    for (const box of managers.values()) box.close();
    managers.clear();
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k?.startsWith('astral.outbox:')) sessionStorage.removeItem(k);
    }
  });
export function useMessageOutbox(
  settings: Settings,
  owner: string,
  computer?: { deviceId: string; projectId: string },
) {
  const target = computer ? JSON.stringify([computer.deviceId, computer.projectId]) : 'server';
  const scope = resourceScope(settings) + ':' + target,
    key = 'astral.outbox:' + JSON.stringify([serverIdentity(settings), owner, target]);
  const manager = useMemo(() => {
    const existing = managers.get(scope);
    if (existing) return existing;
    let initial: OutboxRow[] = [];
    try {
      const data = JSON.parse(sessionStorage.getItem(key) || '[]');
      if (Array.isArray(data)) initial = data;
    } catch {}
    const box = createMessageOutbox({
      initial,
      persist: (rows: OutboxRow[]) => sessionStorage.setItem(key, JSON.stringify(rows)),
      send: async (payload: OutboxRow['payload'], signal: AbortSignal) => {
        if (computer) {
          const r = await api<{ job: unknown }>(
            settings,
            '/relay/submissions',
            {
              id: payload.id,
              deviceId: computer.deviceId,
              projectId: computer.projectId,
              conversationId: payload.conversationId,
              input: payload.input,
              access: payload.access,
              execute: payload.execute === true,
              thinkingLevel: payload.thinkingLevel,
              attachments: payload.attachments,
              deliveryPreference: payload.deliveryPreference || 'steer',
            },
            undefined,
            false,
            { signal, timeout: 30000 },
          );
          return { task: r.job as PiTask };
        }
        return api<{ task: PiTask }>(settings, '/pi/submissions', payload, undefined, false, {
          signal,
          timeout: 30000,
        });
      },
      lookup: async (id: string) => {
        try {
          const result = await api<{ task?: PiTask; job?: PiTask }>(
            settings,
            (computer ? '/relay/jobs/' : '/pi/tasks/') + id,
            undefined,
            undefined,
            false,
            { fresh: true },
          );
          return computer ? { task: result.job } : result;
        } catch (e) {
          if ((e as Error & { status?: number }).status === 404) return null;
          throw e;
        }
      },
    });
    managers.set(scope, box);
    queueMicrotask(() => {
      for (const row of box.snapshot())
        if (row.status === 'unknown') void box.reconcile(row.payload.id);
    });
    return box;
  }, [scope, key]);
  const rows = useSyncExternalStore(
    manager.subscribe,
    manager.snapshot,
    manager.snapshot,
  ) as OutboxRow[];
  return { manager, rows };
}
