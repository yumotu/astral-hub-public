import test from 'node:test';
import assert from 'node:assert/strict';
import { mailBackTarget } from '../shared/mail-navigation.mjs';
test('mail back unwinds editor, summary, message, batch selection, filters and folder before leaving mail', () => {
  const state = {
    folderEditor: true,
    summaryOpen: true,
    selected: 101,
    selectedCount: 2,
    query: 'meeting',
    unread: true,
    mailbox: 'Work',
  };
  for (const [target, key, value] of [
    ['folder-editor', 'folderEditor', false],
    ['summary', 'summaryOpen', false],
    ['message', 'selected', null],
    ['selection', 'selectedCount', 0],
    ['filters', 'query', ''],
    ['filters', 'unread', false],
    ['inbox', 'mailbox', 'INBOX'],
  ]) {
    assert.equal(mailBackTarget(state), target);
    state[key] = value;
  }
  assert.equal(mailBackTarget(state), null);
});
