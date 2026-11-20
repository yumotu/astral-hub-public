import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const destination = resolve('web/public/pdfjs');
await mkdir(destination, { recursive: true });
for (const name of ['cmaps', 'standard_fonts', 'wasm', 'iccs'])
  await cp(resolve('node_modules/pdfjs-dist', name), resolve(destination, name), {
    recursive: true,
    force: true,
  });
await cp(resolve('node_modules/pdfjs-dist/LICENSE'), resolve(destination, 'LICENSE'));
console.log('PDF 预览资源已准备');
