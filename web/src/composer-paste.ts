/** Read only the clipboard supplied by the user's paste event; never fetch clipboard URLs. */
export function pastedFiles(
  data: Pick<DataTransfer, 'files' | 'items'>,
  timestamp = Date.now(),
): File[] {
  // files and items commonly describe the same attachment. Prefer the canonical FileList.
  const files = Array.from(data.files || []);
  const incoming = files.length
    ? files
    : Array.from(data.items || [])
        .filter((item) => item.kind === 'file')
        .map((item) => item.getAsFile())
        .filter((file): file is File => !!file);
  return incoming.map((file, index) => {
    if (file.name && file.name !== 'blob') return file;
    const extensions: Record<string, string> = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/webp': 'webp',
      'image/gif': 'gif',
      'image/bmp': 'bmp',
      'image/avif': 'avif',
      'application/pdf': 'pdf',
      'text/plain': 'txt',
    };
    const extension = extensions[file.type] || 'bin';
    const name = `${file.type.startsWith('image/') ? '粘贴图片' : '粘贴文件'}-${timestamp}-${index + 1}.${extension}`;
    return new File([file], name, { type: file.type, lastModified: file.lastModified });
  });
}

/** For mixed text/file pastes, retain normal textarea replacement and length semantics. */
export function insertPastedText(
  value: string,
  text: string,
  start: number,
  end: number,
  limit = 8000,
) {
  start = Math.max(0, Math.min(start, value.length));
  end = Math.max(start, Math.min(end, value.length));
  const inserted = text.slice(0, Math.max(0, limit - value.length + end - start));
  return {
    value: value.slice(0, start) + inserted + value.slice(end),
    cursor: start + inserted.length,
  };
}
