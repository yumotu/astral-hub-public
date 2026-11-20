// Translate the model's common TeX delimiters before CommonMark consumes their
// backslashes. Fenced/inline code and incomplete streamed formulae stay literal.
export function normalizeMathDelimiters(text) {
  let out = '',
    i = 0,
    fence = null;
  while (i < text.length) {
    if (i === 0 || text[i - 1] === '\n') {
      const lineEnd = text.indexOf('\n', i),
        end = lineEnd < 0 ? text.length : lineEnd;
      const line = text.slice(i, end),
        run = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (
        run &&
        (!fence ||
          (run[1][0] === fence.char &&
            run[1].length >= fence.size &&
            /^ {0,3}(`{3,}|~{3,})[\t ]*$/.test(line)))
      ) {
        fence = fence ? null : { char: run[1][0], size: run[1].length };
        out += text.slice(i, end);
        i = end;
        continue;
      }
      if (fence || /^( {4}|\t)/.test(line)) {
        out += text.slice(i, end);
        i = end;
        if (i === text.length) break;
      }
    }
    if (text[i] === '`') {
      const marker = text.slice(i).match(/^`+/)[0];
      const runs = /`+/g;
      runs.lastIndex = i + marker.length;
      let candidate,
        end = -1;
      while ((candidate = runs.exec(text))) {
        if (candidate[0].length === marker.length) {
          end = candidate.index;
          break;
        }
      }
      if (end >= 0) {
        out += text.slice(i, end + marker.length);
        i = end + marker.length;
        continue;
      }
    }
    if (!fence && text[i] === '\\' && text[i - 1] !== '\\' && ['(', '['].includes(text[i + 1])) {
      const display = text[i + 1] === '[',
        close = display ? '\\]' : '\\)',
        end = text.indexOf(close, i + 2);
      if (end >= 0) {
        const body = text.slice(i + 2, end);
        // Never borrow a formula terminator from a code span or fenced block.
        if (body.trim() && body.length <= 32000 && !/`|^ {0,3}~{3,}/m.test(body)) {
          out += display ? '\n$$\n' + body.trim() + '\n$$\n' : '$' + body + '$';
          i = end + 2;
          continue;
        }
      }
    }
    out += text[i++];
  }
  return out;
}
