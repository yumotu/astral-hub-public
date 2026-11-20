import test from 'node:test';
import assert from 'node:assert/strict';
import { safeMailHref, mailLinkLabel } from '../shared/mail-display.mjs';
import { sanitizeMailHtml, MAX_MAIL_HTML } from '../server/mail-html.mjs';
import { mailTableKind } from '../shared/mail-layout.mjs';
import { nestedNotificationHtml } from './fixtures/mail-layout.mjs';
import { createRequire } from 'node:module';
const { mailLink } = createRequire(import.meta.url)('../desktop/mail-links.cjs');

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
