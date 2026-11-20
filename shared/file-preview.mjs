export function imageContentType(bytes) {
  const starts = (values) => values.every((value, i) => bytes[i] === value);
  if (starts([137, 80, 78, 71, 13, 10, 26, 10])) return 'image/png';
  if (starts([255, 216, 255])) return 'image/jpeg';
  const ascii = (start, end) => String.fromCharCode(...bytes.subarray(start, end));
  if (['GIF87a', 'GIF89a'].includes(ascii(0, 6))) return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// Filename metadata selects an icon only. Actual previews still verify the bytes.
export function attachmentKind(name) {
  const extension = String(name).toLowerCase().split('.').at(-1);
  const groups = {
    image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'heic', 'heif', 'svg'],
    pdf: ['pdf'],
    document: ['doc', 'docx', 'odt', 'rtf'],
    spreadsheet: ['xls', 'xlsx', 'xlsm', 'ods', 'csv', 'tsv'],
    presentation: ['ppt', 'pptx', 'odp', 'key'],
    archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'],
    code: [
      'js',
      'jsx',
      'ts',
      'tsx',
      'py',
      'java',
      'c',
      'h',
      'cpp',
      'cs',
      'go',
      'rs',
      'sh',
      'bash',
      'sql',
      'json',
      'yaml',
      'yml',
      'xml',
      'html',
      'css',
      'vue',
      'swift',
      'kt',
    ],
    audio: ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'],
    video: ['mp4', 'mov', 'webm', 'mkv', 'avi'],
    text: ['txt', 'md', 'markdown', 'log'],
  };
  return (
    Object.entries(groups).find(([, extensions]) => extensions.includes(extension))?.[0] || 'file'
  );
}
export function attachmentBadge(name) {
  const parts = String(name).split('.');
  const extension = parts.length > 1 ? parts.at(-1) : '';
  return /^[a-z0-9]{1,8}$/i.test(extension) ? extension.toUpperCase() : 'FILE';
}
export function filePreviewKind(name, bytes) {
  const extension = name.toLowerCase().split('.').at(-1);
  if (imageContentType(bytes)) return 'image';
  if (String.fromCharCode(...bytes.subarray(0, 5)) === '%PDF-') return 'pdf';
  if (['docx', 'xlsx'].includes(extension) && bytes[0] === 80 && bytes[1] === 75) return extension;
  if (['md', 'markdown'].includes(extension)) return 'markdown';
  if (
    [
      'txt',
      'csv',
      'tsv',
      'json',
      'yaml',
      'yml',
      'xml',
      'html',
      'css',
      'js',
      'ts',
      'py',
      'sh',
      'log',
    ].includes(extension)
  )
    return 'text';
  return 'unsupported';
}

export function previewErrorMessage(error) {
  const message = String(error?.message || error || '');
  if (/[\u3400-\u9fff]/.test(message)) return message;
  return '此文件内容不完整、编码异常或格式不受支持，无法预览。下载会保留原始内容，不会修复文件。';
}
