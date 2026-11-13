// Explicit presentation markers, never Markdown headings/length heuristics.
// A complete block is needed before it is presented as a finished artifact;
// incomplete streamed output stays ordinary text until its closing marker.
const variants = new Set(['document', 'standard', 'email', 'chat_message', 'social_post']);
export const assistantArtifactRules = `成品排版：普通回答、进度说明、解释、列表不使用外框标记。只有用户可直接复制使用的完整文稿、邮件或Markdown文档才用独立块包裹，格式为单独一行 :::writing{variant="document" title="文稿标题"}，接成品正文，最后单独一行 :::。前后解释放块外。不要把代码示例里的标记当作真实文稿；不要仅因使用标题或列表就包裹整条回复。`;

export function splitAssistantArtifacts(input) {
  const text = typeof input === 'string' ? input : '';
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
  const parts = [];
  let plain = '',
    pending = null,
    fence = null;
  const pushPlain = () => {
    if (plain) parts.push({ kind: 'text', text: plain });
    plain = '';
  };
  for (const line of lines) {
    const content = line.replace(/\r?\n$/, '');
    const code = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(content);
    if (code) {
      if (!fence) fence = { char: code[1][0], size: code[1].length };
      else if (code[1][0] === fence.char && code[1].length >= fence.size && !code[2].trim())
        fence = null;
      if (pending) pending.body += line;
      else plain += line;
      continue;
    }
    if (!fence && !pending) {
      const open = /^:::writing\{([^{}\r\n]{0,500})\}\s*$/.exec(content);
      if (open) {
        const fields = [...open[1].matchAll(/([a-zA-Z]+)="([^"\r\n]*)"/g)];
        const attrs = Object.fromEntries(fields.map((m) => [m[1], m[2]]));
        const remainder = open[1].replace(/([a-zA-Z]+)="([^"\r\n]*)"/g, '').trim();
        if (!remainder && variants.has(attrs.variant)) {
          pending = { opener: line, body: '', variant: attrs.variant, title: attrs.title || '' };
          continue;
        }
      }
      // A transport chunk may stop halfway through the opener. Keep that
      // unfinished control line hidden until it can be parsed or shown as
      // ordinary malformed text after the next chunk arrives.
      if (!line.endsWith('\n') && /^:::writing(?:\{[^{}\r\n]{0,500})?$/.test(content)) continue;
    }
    if (!fence && pending && /^:::\s*$/.test(content)) {
      if (pending.body.trim()) {
        pushPlain();
        parts.push({
          kind: 'artifact',
          variant: pending.variant,
          title: pending.title,
          text: pending.body.replace(/\r?\n$/, ''),
        });
      } else plain += pending.opener + pending.body + line;
      pending = null;
      continue;
    }
    if (pending) pending.body += line;
    else plain += line;
  }
  if (pending) plain += pending.body;
  pushPlain();
  return parts;
}

export function assistantCopyText(input) {
  return splitAssistantArtifacts(input)
    .map((part) => part.text)
    .join('\n');
}
