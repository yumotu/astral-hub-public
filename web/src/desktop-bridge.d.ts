export {};
export type LocalComputerStatus = {
  configured: boolean;
  running: boolean;
  deviceId?: string;
  name?: string;
  server?: string;
  error?: string;
  cancelled?: boolean;
  projects: {
    id: string;
    name: string;
    root: string;
    allowWrite: boolean;
    allowExecute: boolean;
  }[];
};
export type LocalComputerIdentity = { server: string; owner: string };
export type DesktopWindowState = { platform: string; fullScreen: boolean; revision: number };
declare global {
  interface Window {
    astralDesktop?: {
      windowControls?: {
        status: () => Promise<DesktopWindowState | null>;
        action: (action: 'exit-fullscreen' | 'minimize' | 'close') => Promise<DesktopWindowState>;
        onChange: (callback: (state: DesktopWindowState) => void) => () => void;
      };
      computer?: {
        status: (v: LocalComputerIdentity) => Promise<LocalComputerStatus>;
        pair: (
          v: LocalComputerIdentity & { code: string; allowWrite: boolean; allowExecute: boolean },
        ) => Promise<LocalComputerStatus>;
        start: (v: LocalComputerIdentity) => Promise<LocalComputerStatus>;
        stop: (v: LocalComputerIdentity) => Promise<LocalComputerStatus>;
        grant: (
          v: LocalComputerIdentity & {
            projectId?: string;
            remove?: boolean;
            allowWrite?: boolean;
            allowExecute?: boolean;
          },
        ) => Promise<LocalComputerStatus>;
      };
      openMailLink?: (url: string) => Promise<{ opened: boolean }>;
      updates?: {
        platform: () => Promise<string>;
        status: () => Promise<{ state: string; received: number; total: number }>;
        download: (value: {
          url: string;
          asset: { platform: string; name: string; bytes: number; sha256: string };
        }) => Promise<{ ready: boolean }>;
        cancel: () => Promise<void>;
        install: () => Promise<{ opened: boolean }>;
        onProgress: (
          callback: (value: { state: string; received: number; total: number }) => void,
        ) => () => void;
      };
      notifications: {
        supported: () => Promise<boolean>;
        show: (notice: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
        onClick: (
          callback: (notice: {
            id?: string;
            scope: string;
            conversationId?: string;
            taskId?: string;
          }) => void,
        ) => () => void;
      };
    };
  }
}
