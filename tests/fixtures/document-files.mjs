import { zipSync, unzipSync, strToU8 } from 'fflate';
const zip = (files) =>
  Buffer.from(
    zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)]))),
  );
const relationships = (target) =>
  `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${target}"/></Relationships>`;
export function documentFixtures() {
  const docx = zip({
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': relationships('word/document.xml'),
    'word/document.xml':
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>星屿 Word 文件验收</w:t></w:r></w:p><w:p><w:r><w:t>Astral DOCX preview OK. Reference: 0720.</w:t></w:r></w:p><w:p><w:r><w:t>中文内容、文件发送与预览测试。</w:t></w:r></w:p></w:body></w:document>',
  });
  const xlsx = zip({
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels': relationships('xl/workbook.xml'),
    'xl/workbook.xml':
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="验收清单" sheetId="1" r:id="rId1"/><sheet name="第二工作表" sheetId="2" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml':
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>文件类型</t></is></c><c r="B1" t="inlineStr"><is><t>状态</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Astral XLSX preview OK</t></is></c><c r="B2"><v>42</v></c></row></sheetData></worksheet>',
    'xl/worksheets/sheet2.xml':
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>第二工作表预览成功</t></is></c></row></sheetData></worksheet>',
  });
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',
  ];
  const stream = (text) => {
    const content = `BT /F1 20 Tf 50 720 Td (${text}) Tj ET`;
    return `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`;
  };
  objects.push(
    stream('Astral PDF preview OK - page 1'),
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
    stream('Astral PDF preview OK - page 2'),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  );
  let pdf = '%PDF-1.4\n',
    offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => String(offset).padStart(10, '0') + ' 00000 n \n')
    .join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return [
    { name: 'Word-验收.docx', bytes: docx },
    { name: 'Excel-验收.xlsx', bytes: xlsx },
    {
      name: 'Markdown-验收.md',
      bytes: Buffer.from(
        '# 星屿 Markdown 预览\n\nAstral Markdown preview OK.\n\n| 项目 | 状态 |\n| --- | --- |\n| 文件发送 | OK |\n\n```js\nconst reference = 720;\n```\n\n<script>window.__unsafe_preview = true</script>\n',
      ),
    },
    { name: 'PDF-验收.pdf', bytes: Buffer.from(pdf) },
    {
      name: '图片-验收.png',
      bytes: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
    },
  ];
}

// Valid stored Office parts and a PDF comment before xref increase the actual
// input size without increasing page count or text output. No renamed fake files.
export function largeDocumentFixtures() {
  const files = documentFixtures();
  const word = unzipSync(files[0].bytes);
  word['[Content_Types].xml'] = strToU8(new TextDecoder().decode(word['[Content_Types].xml']).replace('</Types>','<Default Extension="bin" ContentType="application/octet-stream"/></Types>'));
  word['word/media/qa-padding-1.bin'] = new Uint8Array(8*1024*1024);
  word['word/media/qa-padding-2.bin'] = new Uint8Array(8*1024*1024);
  const pdf = files[3].bytes.toString('ascii');
  const xref = pdf.indexOf('xref\n0 ');
  const padding = '% synthetic-large-input '+ ' '.repeat(16*1024*1024) + '\n';
  const footer = pdf.slice(xref).replace(/startxref\n\d+/,`startxref\n${xref+padding.length}`);
  return [
    {name:'16MiB-真实Word.docx',bytes:Buffer.from(zipSync(word,{level:0}))},
    {name:'16MiB-真实PDF.pdf',bytes:Buffer.from(pdf.slice(0,xref)+padding+footer,'ascii')},
  ];
}
