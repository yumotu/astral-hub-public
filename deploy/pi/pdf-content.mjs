import { copyFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

export function documentReadOptions(p = {}) {
  const startPage = p.startPage ?? 1,
    pageLimit = p.pageLimit ?? 3,
    mode = p.mode ?? 'auto';
  if (
    !Number.isSafeInteger(startPage) ||
    startPage < 1 ||
    startPage > 100000 ||
    !Number.isSafeInteger(pageLimit) ||
    pageLimit < 1 ||
    pageLimit > 8 ||
    !['auto', 'text', 'ocr'].includes(mode)
  )
    throw Error('页码、每批页数或识别方式不正确。');
  return { startPage, pageLimit, mode };
}

export function needsOcr(text) {
  const characters = [...text.replace(/\s/g, '')];
  const bad = characters.filter((c) =>
    /[\u0000-\u001f\u007f-\u009f\ufffd\ue000-\uf8ff]/u.test(c),
  ).length;
  return characters.length < 12 || (bad > 1 && bad / characters.length > 0.03);
}

// All parsers, rasterizers, WASM and language data are pinned local dependencies.
// Files are data: no JavaScript/forms, URL fetches, system installation or model keys.
export async function documentContent(bytes, p, { require, progress = () => {} }) {
  const { startPage, pageLimit, mode } = documentReadOptions(p);
  const canvas = require('@napi-rs/canvas');
  let ocr, languages, pdf;
  async function recognize(image) {
    if (!ocr) {
      languages = p.ocrDirectory;
      if (!languages) throw Error('文档识别临时目录不可用。');
      for (const code of ['chi_sim', 'eng']) {
        const data = require('@tesseract.js-data/' + code);
        await copyFile(
          join(data.langPath, code + '.traineddata.gz'),
          join(languages, code + '.traineddata.gz'),
        );
      }
      progress({ phase: '正在加载离线中英文识别' });
      ocr = await require('tesseract.js').createWorker(['chi_sim', 'eng'], 1, {
        langPath: languages,
        cacheMethod: 'none',
        gzip: true,
        // The parent terminates this whole worker tree on timeout/cancellation.
        errorHandler: () => {},
      });
    }
    const { data } = await ocr.recognize(image);
    return {
      text: data.text.slice(0, 160000),
      confidence: Math.max(0, Math.min(100, data.confidence || 0)),
    };
  }
  try {
    if (p.format === 'image') {
      const size = require('image-size').imageSize(bytes);
      if (!size.width || !size.height || size.width * size.height > 20e6)
        throw Error('图片像素过大，请缩小到2000万像素以内后识别。原文件仍可下载。');
      const image = await canvas.loadImage(bytes);
      const scale = Math.min(1, 2400 / Math.max(image.width, image.height));
      const surface = canvas.createCanvas(
        Math.max(1, Math.round(image.width * scale)),
        Math.max(1, Math.round(image.height * scale)),
      );
      const ctx = surface.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, surface.width, surface.height);
      ctx.drawImage(image, 0, 0, surface.width, surface.height);
      const result = await recognize(await surface.encode('png'));
      return {
        totalPages: 1,
        nextPage: null,
        pages: [{ page: 1, method: 'ocr', ...result }],
        warning: 'OCR可能误识别姓名、数字、符号与版面；重要信息应核对原件。',
      };
    }
    const unpdf = require('unpdf');
    const CanvasFactory = await unpdf.createIsomorphicCanvasFactory(() => Promise.resolve(canvas));
    const assets = dirname(require.resolve('pdfjs-dist/package.json'));
    pdf = await unpdf.getDocumentProxy(new Uint8Array(bytes), {
      CanvasFactory,
      useSystemFonts: false,
      isEvalSupported: false,
      maxImageSize: 20e6,
      disableFontFace: true,
      cMapPacked: true,
      cMapUrl: pathToFileURL(join(assets, 'cmaps') + '/').href,
      standardFontDataUrl: pathToFileURL(join(assets, 'standard_fonts') + '/').href,
      wasmUrl: pathToFileURL(join(assets, 'wasm') + '/').href,
      verbosity: 0,
    });
    if (startPage > pdf.numPages) throw Error(`页码超出范围，PDF共${pdf.numPages}页。`);
    const pages = [],
      last = Math.min(pdf.numPages, startPage + pageLimit - 1);
    for (let number = startPage; number <= last; number++) {
      progress({ page: number, totalPages: pdf.numPages, phase: '正在读取PDF页面' });
      const page = await pdf.getPage(number);
      let text = '',
        extractionFailed = false;
      try {
        const content = await page.getTextContent();
        for (const item of content.items)
          if ('str' in item) {
            text += item.str + (item.hasEOL ? '\n' : ' ');
            if (text.length > 160000) {
              text = text.slice(0, 160000);
              break;
            }
          }
      } catch {
        extractionFailed = true;
      }
      const suspect = extractionFailed || needsOcr(text);
      if (mode === 'ocr' || (mode === 'auto' && suspect)) {
        progress({ page: number, totalPages: pdf.numPages, phase: '正在离线识别PDF页面' });
        const viewport = page.getViewport({ scale: 1 });
        if (
          !Number.isFinite(viewport.width * viewport.height) ||
          viewport.width <= 0 ||
          viewport.height <= 0
        )
          throw Error('PDF页面尺寸不正确，无法渲染。');
        const scale = Math.min(
          3,
          2400 / Math.max(viewport.width, viewport.height),
          Math.sqrt(5e6 / (viewport.width * viewport.height)),
        );
        const rendered = await unpdf.renderPageAsImage(pdf, number, {
          scale,
          canvasImport: () => Promise.resolve(canvas),
        });
        const recognized = await recognize(Buffer.from(rendered));
        pages.push({
          page: number,
          method: 'ocr',
          ...recognized,
          ...(recognized.text.trim()
            ? {}
            : { warning: '此页已尝试OCR但没有识别出文字；不能据此断言文件为空或缺失映射表。' }),
        });
      } else
        pages.push({
          page: number,
          method: 'text',
          text,
          ...(suspect ? { warning: '此页文字可能缺失或乱码，可用mode:ocr识别原始页面。' } : {}),
        });
      page.cleanup();
    }
    return {
      totalPages: pdf.numPages,
      nextPage: last < pdf.numPages ? last + 1 : null,
      pages,
      ...(pages.some((p) => p.method === 'ocr')
        ? { warning: 'OCR可能误识别姓名、数字、符号与版面；重要信息应核对原件。' }
        : {}),
    };
  } finally {
    await ocr?.terminate().catch(() => {});
    await pdf?.loadingTask.destroy().catch(() => {});
  }
}
