import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from 'react';
import { Capacitor } from '@capacitor/core';
import { Check, Palette } from 'lucide-react';
import { nativeAppearance } from './native-appearance';
import {
  themePresets,
  themeColors,
  themePreset,
  appearanceMode,
  resolvedAppearance,
} from '../../shared/theme-presets.mjs';
import './theme-settings.css';
export type Appearance = 'light' | 'dark';
type AppearanceMode = Appearance | 'system';
const ThemeContext = createContext<{
  appearance: Appearance;
  mode: AppearanceMode;
  palette: string;
  toggle: () => void;
  setMode: (mode: AppearanceMode) => void;
  setPalette: (palette: string) => void;
}>({
  appearance: 'light',
  mode: 'light',
  palette: 'blue',
  toggle: () => {},
  setMode: () => {},
  setPalette: () => {},
});
function loadMode(): AppearanceMode {
  try {
    const saved = localStorage.getItem('astral.appearance');
    const legacy =
      saved === 'light' || saved === 'dark'
        ? saved
        : localStorage.getItem('astral.pi.appearance') === 'light'
          ? 'light'
          : 'dark';
    return appearanceMode(localStorage.getItem('astral.appearanceMode'), legacy) as AppearanceMode;
  } catch {
    return 'dark';
  }
}
function loadPalette() {
  try {
    return themePreset(localStorage.getItem('astral.palette')).id;
  } catch {
    return 'blue';
  }
}
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<AppearanceMode>(loadMode);
  const [palette, setPaletteState] = useState(loadPalette);
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  const appearance = resolvedAppearance(mode, systemDark) as Appearance;
  const setPalette = (value: string) => setPaletteState(themePreset(value).id);
  useLayoutEffect(() => {
    const colors = themeColors(palette, appearance),
      root = document.documentElement;
    root.dataset.theme = appearance;
    root.dataset.palette = palette;
    root.style.colorScheme = appearance;
    for (const [key, value] of Object.entries(colors)) root.style.setProperty('--' + key, value);
    root.querySelector('meta[name="theme-color"]')?.setAttribute('content', colors.surface);
    if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android')
      void nativeAppearance.setTheme({ appearance, background: colors.surface }).catch(() => {});
    try {
      localStorage.setItem('astral.appearance', appearance);
      localStorage.setItem('astral.appearanceMode', mode);
      localStorage.setItem('astral.palette', palette);
    } catch {}
  }, [appearance, palette, mode]);
  useLayoutEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const system = () => setSystemDark(media.matches);
    const update = (e: StorageEvent) => {
      if (e.key === 'astral.appearanceMode') setMode(appearanceMode(e.newValue) as AppearanceMode);
      if (e.key === 'astral.palette') setPalette(e.newValue || 'blue');
      if (
        e.key === 'astral.appearance' &&
        !localStorage.getItem('astral.appearanceMode') &&
        (e.newValue === 'light' || e.newValue === 'dark')
      )
        setMode(e.newValue);
    };
    media.addEventListener('change', system);
    window.addEventListener('storage', update);
    return () => {
      media.removeEventListener('change', system);
      window.removeEventListener('storage', update);
    };
  }, []);
  return (
    <ThemeContext.Provider
      value={{
        appearance,
        mode,
        palette,
        setMode,
        setPalette,
        toggle: () => setMode(appearance === 'dark' ? 'light' : 'dark'),
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}
export const useTheme = () => useContext(ThemeContext);
export function ThemeSettings() {
  const { appearance, mode, palette, setMode, setPalette } = useTheme();
  return (
    <section className="surface theme-settings" aria-label="外观与配色">
      <div className="section-title">
        <Palette size={21} />
        <h2>外观与配色</h2>
        <span className="tag">当前设备 · 立即保存</span>
      </div>
      <label className="field-label" htmlFor="theme-appearance">
        明暗模式
      </label>
      <select
        id="theme-appearance"
        className="standard-input"
        value={mode}
        onChange={(e) => setMode(e.target.value as AppearanceMode)}
      >
        <option value="system">跟随系统</option>
        <option value="light">浅色</option>
        <option value="dark">深色</option>
      </select>
      <p className="field-help">选择你习惯的背景与主题色，适用于聊天、文件、邮件和其他页面。</p>
      <div className="theme-preset-grid" role="group" aria-label="主题配色">
        {themePresets.map((p) => {
          const colors = themeColors(p.id, appearance);
          return (
            <button
              type="button"
              key={p.id}
              className="theme-preset"
              aria-pressed={palette === p.id}
              onClick={() => setPalette(p.id)}
              style={{
                background: colors['surface-soft'],
                color: colors.text,
                borderColor: palette === p.id ? colors.accent : colors.border,
              }}
            >
              <span
                className="theme-preset-swatch"
                aria-hidden="true"
                style={{ background: colors.surface }}
              >
                <i style={{ background: colors['surface-active'] }} />
                <i style={{ background: colors.accent }} />
              </span>
              <span>
                <strong>{p.name}</strong>
                <small>{p.description}</small>
              </span>
              {palette === p.id && <Check size={16} style={{ color: colors.accent }} />}
            </button>
          );
        })}
      </div>
    </section>
  );
}
