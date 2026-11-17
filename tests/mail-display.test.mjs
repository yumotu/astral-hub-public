import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import assert from 'node:assert/strict';
import { safeMailHref, mailLinkLabel, mailAssistantDraft } from '../shared/mail-display.mjs';
import { splitAssistantArtifacts } from '../shared/assistant-artifacts.mjs';
import { sanitizeMailHtml, MAX_MAIL_HTML } from '../server/mail-html.mjs';
import { mailTableKind } from '../shared/mail-layout.mjs';
import { nestedNotificationHtml } from './fixtures/mail-layout.mjs';
import { createRequire } from 'node:module';
const { mailLink } = createRequire(import.meta.url)('../desktop/mail-links.cjs');

test('mail adopts one complete manuscript body without presentation markers or surrounding commentary', () => {
  for (const variant of ['email', 'document', 'standard']) {
    const body = 'I am writing to confirm.\r\n\r\n谢谢。';
    const output = `Here is the draft.\r\n:::writing{variant="${variant}" title="回复"}\r\n${body}\r\n:::\r\nPlease review.`;
    assert.deepEqual(mailAssistantDraft(output), { text: body });
  }
  const body = 'Example:\n```md\n:::writing{variant="email"}\nexample\n:::\n```\nRegards.';
  assert.deepEqual(mailAssistantDraft(`:::writing{variant="email"}\n${body}\n:::`), { text: body });
});

test('mail preserves ordinary writing and literal fenced marker examples', () => {
  for (const text of [
    'I am writing about the writing workshop.',
    '```md\n:::writing{variant="email"}\nExample\n:::\n```',
    'Inline :::writing is a literal example.',
    'DSL example:\n:::writing-team\nKeep this exact text.',
    ':::writing.example\nLiteral directive.',
    ':::writing notes about the workshop',
    ':::writ',
    ' :::writing{variant="email"}\nIndented literal\n :::',
    ':::Writing{variant="email"}\nCase-sensitive literal\n:::',
    '```md\n:::writing{variant="email" variant="email"}\nExample\n:::\n```',
  ])
    assert.deepEqual(mailAssistantDraft(text), { text });
});

test('mail rejects duplicate attributes without changing the shared preview parser', () => {
  for (const attrs of [
    'variant="email" variant="email"',
    'variant="chat_message" variant="email"',
    'variant="email" variant="chat_message"',
    'variant="email" title="A" title="B"',
  ]) {
    const input = `:::writing{${attrs}}\nBody\n:::`;
    assert.equal(
      splitAssistantArtifacts(input).filter((part) => part.kind === 'artifact').length,
      1,
    );
    const result = mailAssistantDraft(input);
    assert.ok(result.error, attrs);
    assert.equal(result.text, undefined);
  }
  assert.deepEqual(
    mailAssistantDraft(':::writing{Variant="chat_message" variant="email"}\nBody\n:::'),
    { text: 'Body' },
  );
});

test('mail keeps non-grammar second markers as outside text, not extra body candidates', () => {
  const complete = ':::writing{variant="email"}\nBody\n:::';
  for (const suffix of [':::writ', ' :::writing{variant="unknown"}\nSecond\n :::'])
    assert.deepEqual(mailAssistantDraft(complete + '\n' + suffix), { text: 'Body' });
});

test('mail rejects ambiguous, unfinished, empty and unsupported manuscript wrappers', () => {
  const complete = ':::writing{variant="email"}\nFirst\n:::';
  for (const text of [
    complete + '\n' + complete,
    ':::writing',
    ':::writing{variant="email"',
    ':::writing{variant="email"}\nUnfinished',
    ':::writing{variant="email"}\n:::',
    ':::writing{variant="unknown"}\nBody\n:::',
    ':::writing{variant="chat_message"}\nBody\n:::',
    ':::writing{variant="email" invalid}\nBody\n:::',
    ':::writing{variant="email"} trailing text\nBody\n:::',
    ':::writing   ',
    complete + '\n:::writing{variant="email"}\nUnfinished',
  ]) {
    const result = mailAssistantDraft(text);
    assert.ok(result.error, text);
    assert.equal(result.text, undefined);
  }
});

test('composer adoption handler keeps the draft on errors, adopts the parsed body and supports undo', () => {
  const file = ts.createSourceFile(
    'MailComposer.tsx',
    readFileSync(new URL('../web/src/MailComposer.tsx', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const handlers = [];
  function visit(node) {
    if (ts.isArrowFunction(node)) handlers.push(node.getText(file));
    ts.forEachChild(node, visit);
  }
  visit(file);
  const adopt = handlers.find((text) =>
    text.includes('const result = mailAssistantDraft(task.output)'),
  );
  const undo = handlers.find((text) => text.includes("update('text', previousText)"));
  assert.ok(adopt);
  assert.ok(undo);
  let draft = { text: 'Original draft' },
    previousText,
    error,
    notice;
  const bindings = {
    mailAssistantDraft,
    setError: (value) => {
      error = value;
    },
    setPreviousText: (value) => {
      previousText = value;
    },
    setNotice: (value) => {
      notice = value;
    },
    update: (field, value) => {
      draft[field] = value;
    },
  };
  function run(handler, values) {
    const scope = { ...bindings, draft, previousText, ...values };
    const javascript = ts.transpile('const handler = ' + handler, {
      target: ts.ScriptTarget.ES2022,
    });
    Function(...Object.keys(scope), javascript + '; handler();')(...Object.values(scope));
  }
  for (const output of [
    ':::writing{variant="email"}\nIncomplete',
    ':::writing{variant="email"}\nA\n:::\n:::writing{variant="email"}\nB\n:::',
    ':::writing{variant="email" variant="email"}\nBody\n:::',
    ':::writing{variant="chat_message" variant="email"}\nBody\n:::',
    ':::writing{variant="email" variant="chat_message"}\nBody\n:::',
  ]) {
    run(adopt, { task: { output } });
    assert.equal(draft.text, 'Original draft');
    assert.equal(previousText, undefined);
    assert.ok(error);
  }
  run(adopt, { task: { output: 'Explanation\n:::writing{variant="email"}\nBody\n:::\nReview' } });
  assert.equal(draft.text, 'Body');
  assert.equal(previousText, 'Original draft');
  assert.equal(error, '');
  assert.ok(notice);
  run(undo);
  assert.equal(draft.text, 'Original draft');
  assert.equal(previousText, null);
  const plain = 'DSL example:\n:::writing-team\nKeep this exact text.';
  run(adopt, { task: { output: plain } });
  assert.equal(draft.text, plain);
  assert.equal(previousText, 'Original draft');
  assert.equal(error, '');
  run(undo);
  assert.equal(draft.text, 'Original draft');
});

test('desktop mail link boundary permits ordinary websites while rejecting executable, credential-bearing and local paths', () => {
  for (const value of [
    'https://example.com/schedule?id=7',
    'http://example.com/',
    'mailto:recipient@example.com',
  ])
    assert.equal(mailLink(value), safeMailHref(value));
  for (const value of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,bad',
    '//example.com',
    'https://user:pass@example.com/',
    '/api/private',
    'mailto:x@example.com?body=%0aInjected',
    'https://example.com/\n',
  ])
    assert.equal(mailLink(value), '');
});

test('mail keeps meaningful links and collapses bare tracking URLs without losing their destinations', () => {
  const url = 'https://example.com/recruiting?inviteId=private-query&track=long';
  assert.equal(mailLinkLabel('查看面试安排', url), '查看面试安排');
  assert.equal(mailLinkLabel(url, url), '访问 example.com');
  assert.equal(safeMailHref(url), url);
  assert.equal(mailLinkLabel('mailto:me@example.com', 'mailto:me@example.com'), '发送邮件');
  for (const value of [
    'javascript:alert(1)',
    'data:text/html,hi',
    '//tracker.example/open',
    '/api/private',
    'file:///etc/passwd',
    'https://user:pass@example.com/',
    'https://examp\nle.com',
    'mailto:me@example.com?body=%0aInjected',
  ])
    assert.equal(safeMailHref(value), '', value);
  assert.equal(safeMailHref('http://example.com/image', true), '');
});

test('mail HTML retains semantic layout while removing scripts, navigation and unsolicited remote requests', () => {
  const { html, remoteImageCount } = sanitizeMailHtml(
    `<html><head><base href="https://evil.test/"><meta http-equiv="refresh" content="0;url=https://evil.test"><style>body{background:url(https://tracker.test)}</style></head><body onload="alert(1)"><h1>安排</h1><p style="background:url(https://evil.test)">请<a href="https://example.com/details?id=7" onclick="alert(1)" ping="https://tracker.test">查看详情</a></p><table width="9999"><tr><th colspan="2">时间</th><td rowspan="999">周五</td></tr></table><form action="https://evil.test"><input><button>提交</button></form><iframe src="https://evil.test"></iframe><svg onload="alert(1)"><a href="https://evil.test">bad</a></svg><img src="https://image.example/banner.png" alt="安排图"><span data-mail-image="https://forged.test">伪造占位</span><img src="data:image/svg+xml,evil"><script>document.cookie</script><a href="javascript:alert(1)">危险链接</a></body></html>`,
  );
  assert.match(html, /<h1>安排<\/h1>/);
  assert.match(html, /<a href="https:\/\/example.com\/details\?id=7">查看详情<\/a>/);
  assert.match(html, /<th colspan="2">时间<\/th><td>周五<\/td>/);
  assert.match(html, /data-mail-image="https:\/\/image.example\/banner.png"/);
  assert.equal(remoteImageCount, 1);
  assert.doesNotMatch(
    html,
    /<(?:img|script|style|iframe|svg|form|input|button|base|meta)|\s(?:src|style|onload|onclick|ping)=|javascript:|document.cookie|forged.test|tracker.test/,
  );
});

test('mail HTML bounds source size, nesting and remote image placeholders', () => {
  assert.equal(sanitizeMailHtml(null).html, '');
  const result = sanitizeMailHtml('<img src="https://example.com/p">'.repeat(45));
  assert.equal(result.remoteImageCount, 30);
  assert.equal((result.html.match(/data-mail-image=/g) || []).length, 30);
  assert.ok(sanitizeMailHtml('a'.repeat(MAX_MAIL_HTML * 2)).html.length <= MAX_MAIL_HTML);
});

test('layout tables do not inherit data-grid styling, including old cached fragments without roles', () => {
  for (const info of [
    { role: 'presentation', heading: true },
    { rowWidths: [1] },
    { containsTable: true, rowWidths: [2, 2] },
    { nested: true, rowWidths: [3, 3] },
  ])
    assert.equal(mailTableKind(info), 'layout', JSON.stringify(info));
  assert.equal(mailTableKind({ heading: true, nested: true }), 'data');
  assert.equal(mailTableKind({ rowWidths: [3, 3, 3] }), 'data');
  assert.equal(mailTableKind({ rowWidths: [3, 1] }), 'layout');
  const cached = sanitizeMailHtml(nestedNotificationHtml);
  assert.doesNotMatch(cached.html, /role=|style=|<img/);
  assert.match(cached.html, /<caption>阶段结果<\/caption>/);
  assert.match(cached.html, /Build applications \/ web-and-tests/);
  assert.equal(cached.remoteImageCount, 2);
});
