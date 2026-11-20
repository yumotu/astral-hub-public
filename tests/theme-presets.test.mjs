import test from 'node:test';
import assert from 'node:assert/strict';
import {
  themePresets,
  themeColors,
  themePreset,
  appearanceMode,
  resolvedAppearance,
} from '../shared/theme-presets.mjs';
const luminance = (hex) => {
  const rgb = hex
    .match(/[a-f\d]{2}/gi)
    .slice(0, 3)
    .map((x) => parseInt(x, 16) / 255)
    .map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
};
const contrast = (a, b) =>
  (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
test('all presets provide complete light/dark palettes with legible text and buttons', () => {
  const keys = Object.keys(themeColors('blue', 'light')).sort();
  for (const p of themePresets)
    for (const appearance of ['light', 'dark']) {
      const colors = themeColors(p.id, appearance);
      assert.deepEqual(Object.keys(colors).sort(), keys);
      for (const hex of Object.values(colors)) assert.match(hex, /^#[\da-f]{6}([\da-f]{2})?$/i);
      for (const surface of ['surface', 'surface-soft', 'surface-active', 'surface-deep'])
        assert.ok(
          contrast(colors.text, colors[surface]) >= 4.5,
          p.id + ' ' + appearance + ' ' + surface,
        );
      assert.ok(
        contrast(colors['on-accent'], colors.accent) >= 4.5,
        p.id + ' ' + appearance + ' button',
      );
      assert.ok(
        contrast(colors['selection-text'], colors.selection) >= 4.5,
        p.id + ' ' + appearance + ' selection',
      );
    }
});
test('original sage palette and legacy appearance remain selectable with safe fallbacks', () => {
  assert.equal(themePreset('sage').name, '原版护眼');
  assert.equal(themeColors('sage', 'light').surface, '#fffefb');
  assert.equal(themePreset('invalid').id, 'blue');
  assert.equal(appearanceMode('invalid', 'light'), 'light');
  assert.equal(resolvedAppearance('system', true), 'dark');
  assert.equal(resolvedAppearance('system', false), 'light');
  assert.equal(resolvedAppearance('light', true), 'light');
});
