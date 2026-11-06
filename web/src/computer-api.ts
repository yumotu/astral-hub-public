import { api } from './data';
import type { Settings } from './types';
export type ComputerProject = {
  id: string;
  name: string;
  readOnly: boolean;
  allowExecute: boolean;
};
export type ComputerOperation =
  | { kind: 'list' | 'read' | 'download' | 'mkdir'; path: string }
  | { kind: 'write'; path: string; content: string; expectedHash: string }
  | { kind: 'restore'; backupId: string };
export type ComputerPluginManifest = {
  version: number;
  id: string;
  name: string;
  description: string;
  inputLabel: string;
  steps: { tool: string; arguments: Record<string, unknown> }[];
};
export type ComputerPluginOperation =
  | { kind: 'plugin_list' }
  | {
      kind: 'plugin_register';
      manifest: ComputerPluginManifest;
      enabled: boolean;
      expectedHash: string;
    }
  | { kind: 'plugin_remove'; pluginId: string; expectedHash: string };
export type OnlinePackageOperation =
  | { kind: 'package_list' }
  | { kind: 'package_install'; previewId: string; expectedRevision: string; confirmed: true }
  | { kind: 'package_enable'; name: string; enabled: boolean; expectedRevision: string }
  | { kind: 'package_remove'; name: string; expectedRevision: string }
  | { kind: 'package_rollback'; expectedRevision: string; confirmed: true };
export type OperationResult = {
  id: string;
  status: string;
  operation: ComputerOperation;
  result: any;
  error?: string;
};
export async function waitComputerOperation(
  settings: Settings,
  id: string,
): Promise<OperationResult> {
  const started = Date.now();
  while (Date.now() - started < 80000) {
    const r = await api<{ operation: OperationResult }>(
      settings,
      '/relay/operations/' + id,
      undefined,
      undefined,
      false,
      { fresh: true },
    );
    if (!['queued', 'running'].includes(r.operation.status)) return r.operation;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw Error('请求仍保留在服务器，未自动重发。可点“查看上次请求”继续查询。');
}
