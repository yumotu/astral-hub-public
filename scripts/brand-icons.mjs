import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import { brandSvg, brandColor, brandPath } from '../shared/brand-icon.mjs';
const png = (size, shape) =>
  Buffer.from(
    new Resvg(brandSvg({ shape }), {
      fitTo: { mode: 'width', value: size },
      font: { loadSystemFonts: false },
    })
      .render()
      .asPng(),
  );
function ico(bytes) {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(bytes.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, bytes]);
}
function icns() {
  const entries = [
    [128, 'ic07'],
    [256, 'ic08'],
    [512, 'ic09'],
    [1024, 'ic10'],
  ].map(([size, tag]) => {
    const data = png(size),
      header = Buffer.alloc(8);
    header.write(tag);
    header.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([header, data]);
  });
  const header = Buffer.alloc(8);
  header.write('icns');
  header.writeUInt32BE(
    entries.reduce((n, b) => n + b.length, 8),
    4,
  );
  return Buffer.concat([header, ...entries]);
}
export async function generateBrandIcons(root = process.cwd(), { check = false } = {}) {
  const files = new Map([
    ['web/public/icon.svg', Buffer.from(brandSvg())],
    ['web/public/icon-192.png', png(192)],
    [
      'web/public/notification-badge.png',
      Buffer.from(
        new Resvg(
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="${brandPath}" fill="none" stroke="white" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
          { fitTo: { mode: 'width', value: 96 } },
        )
          .render()
          .asPng(),
      ),
    ],
    ['android/app/src/main/res/drawable/ic_notification_astral.png', png(192)],
    ['web/public/icon-512.png', png(512)],
    ['web/public/icon-maskable-512.png', png(512, 'maskable')],
    ['web/public/apple-touch-icon.png', png(180)],
    ['desktop/build/icon.png', png(1024)],
    ['desktop/build/icon.ico', ico(png(256))],
    ['desktop/build/icon.icns', icns()],
  ]);
  for (const [density, scale] of [
    ['mdpi', 1],
    ['hdpi', 1.5],
    ['xhdpi', 2],
    ['xxhdpi', 3],
    ['xxxhdpi', 4],
  ]) {
    const dir = 'android/app/src/main/res/mipmap-' + density + '/';
    files.set(dir + 'ic_launcher.png', png(48 * scale));
    files.set(dir + 'ic_launcher_round.png', png(48 * scale, 'round'));
    files.set(dir + 'ic_launcher_foreground.png', png(108 * scale, 'foreground'));
  }
  const vector = `<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="108dp" android:height="108dp" android:viewportWidth="108" android:viewportHeight="108"><group android:translateX="25.2" android:translateY="25.2" android:scaleX="2.4" android:scaleY="2.4"><path android:pathData="${brandPath}" android:fillColor="#00000000" android:strokeColor="#FFFFFFFF" android:strokeWidth="1.9" android:strokeLineCap="round" android:strokeLineJoin="round"/></group></vector>\n`;
  files.set(
    'android/app/src/main/res/drawable-v24/ic_launcher_foreground.xml',
    Buffer.from(vector),
  );
  files.set(
    'android/app/src/main/res/values/ic_launcher_background.xml',
    Buffer.from(
      `<resources><color name="ic_launcher_background">${brandColor}</color></resources>\n`,
    ),
  );
  files.set(
    'android/app/src/main/res/drawable/ic_launcher_background.xml',
    Buffer.from(
      `<shape xmlns:android="http://schemas.android.com/apk/res/android"><solid android:color="${brandColor}"/></shape>\n`,
    ),
  );
  files.set(
    'android/app/src/main/res/drawable/ic_stat_astral.xml',
    Buffer.from(
      `<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="24dp" android:height="24dp" android:viewportWidth="24" android:viewportHeight="24"><path android:pathData="${brandPath}" android:fillColor="#00000000" android:strokeColor="#FFFFFFFF" android:strokeWidth="1.9" android:strokeLineCap="round" android:strokeLineJoin="round"/></vector>\n`,
    ),
  );
  for (const name of ['ic_launcher', 'ic_launcher_round'])
    files.set(
      'android/app/src/main/res/mipmap-anydpi-v33/' + name + '.xml',
      Buffer.from(
        `<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android"><background android:drawable="@color/ic_launcher_background"/><foreground android:drawable="@mipmap/ic_launcher_foreground"/><monochrome android:drawable="@drawable/ic_launcher_foreground"/></adaptive-icon>\n`,
      ),
    );
  for (const [path, expected] of files) {
    const full = resolve(root, path);
    if (check) {
      const actual = await readFile(full);
      if (!actual.equals(expected)) throw Error('品牌图标未同步：' + path);
    } else {
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, expected);
    }
  }
  return [...files.keys()];
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  console.log(
    '统一品牌图标：' +
      (await generateBrandIcons(process.cwd(), { check: process.argv.includes('--check') }))
        .length +
      ' 项',
  );
