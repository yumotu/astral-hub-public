// Synthetic raster-only PDF: no text layer, font or ToUnicode mapping.
export function scannedPdf(jpeg) {
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 360] /Resources << /XObject << /Scan 5 0 R >> >> /Contents 4 0 R >>',
    ),
  ];
  const drawing = Buffer.from('q 600 0 0 360 0 0 cm /Scan Do Q');
  objects.push(
    Buffer.concat([
      Buffer.from(`<< /Length ${drawing.length} >>\nstream\n`),
      drawing,
      Buffer.from('\nendstream'),
    ]),
  );
  objects.push(
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width 1200 /Height 720 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
      ),
      jpeg,
      Buffer.from('\nendstream'),
    ]),
  );
  const chunks = [Buffer.from('%PDF-1.4\n')],
    offsets = [0];
  let position = chunks[0].length;
  for (const [index, object] of objects.entries()) {
    const bytes = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`),
      object,
      Buffer.from('\nendobj\n'),
    ]);
    offsets.push(position);
    position += bytes.length;
    chunks.push(bytes);
  }
  chunks.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((n) => String(n).padStart(10, '0') + ' 00000 n \n')
        .join(
          '',
        )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${position}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(chunks);
}
