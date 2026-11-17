import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { z } from 'zod';
import { dshPromptFailure } from '../shared/dsh-prompt.mjs';

function source(path) {
  return ts.createSourceFile(
    path,
    readFileSync(new URL('../' + path, import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
}
function find(root, predicate) {
  let found;
  function visit(node) {
    if (predicate(node)) found = node;
    ts.forEachChild(node, visit);
  }
  visit(root);
  assert.ok(found);
  return found;
}

test('actual server error JSON and browser API parser preserve only proven submission states', async () => {
  const server = source('server/index.mjs');
  const handler = find(
    server,
    (n) => ts.isCatchClause(n) && n.block.getText(server).includes('const submission ='),
  );
  const data = source('web/src/data.ts');
  const api = find(data, (n) => ts.isFunctionDeclaration(n) && n.name?.text === 'api');
  const javascript = ts.transpile(api.getText(data).replace('export ', ''), {
    target: ts.ScriptTarget.ES2022,
  });
  for (const state of ['rejected', 'unknown', undefined, 'unsafe-value']) {
    let response;
    const error = Object.assign(Error('synthetic error'), {
      status: 404,
      submissionState: state,
      privateValue: 'not serialized',
    });
    Function(
      'e',
      'z',
      'json',
      handler.block.getText(server),
    )(error, z, (status, body) => {
      response = { status, body };
    });
    assert.deepEqual(
      Object.keys(response.body).sort(),
      ['rejected', 'unknown'].includes(state) ? ['error', 'submissionState'] : ['error'],
    );
    const call = Function(
      'fetch',
      'validateSettings',
      'invalidateAPI',
      'clearResourceCaches',
      javascript + '; return api;',
    )(
      async () => ({
        ok: false,
        status: response.status,
        json: async () => JSON.parse(JSON.stringify(response.body)),
      }),
      () => {},
      () => {},
      () => {},
    );
    await assert.rejects(
      call({ url: '', token: 'synthetic' }, '/agent/remote/conversations/id/prompt', {
        text: 'mock',
      }),
      (caught) => {
        assert.equal(
          caught.submissionState,
          ['rejected', 'unknown'].includes(state) ? state : undefined,
        );
        assert.equal(dshPromptFailure(caught).state, state === 'rejected' ? 'rejected' : 'unknown');
        assert.equal(caught.privateValue, undefined);
        return true;
      },
    );
  }
});
