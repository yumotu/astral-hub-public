import { registerPlugin } from '@capacitor/core';
export const nativeAppearance = registerPlugin<{
  setTheme: (options: { appearance: 'light' | 'dark'; background?: string }) => Promise<void>;
  openNotificationSettings: () => Promise<void>;
}>('AppAppearance');
