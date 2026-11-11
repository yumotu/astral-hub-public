import test from 'node:test';
import assert from 'node:assert/strict';
import { packageRelease } from '../shared/release-intent.mjs';

test('only an exact version tag, explicit default-branch release commit or manual release selects protected signing', () => {
  const p = {
    version: '0.8.11',
    eventName: 'push',
    ref: 'refs/heads/main',
    defaultBranch: 'main',
    headMessage: 'release: v0.8.11',
  };
  assert.equal(packageRelease(p), true);
  assert.equal(
    packageRelease({ ...p, headMessage: 'release: v0.8.11\n\nVerified candidate' }),
    true,
  );
  assert.equal(packageRelease({ ...p, headMessage: 'fix: candidate' }), false);
  assert.equal(packageRelease({ ...p, headMessage: 'release: v0.8.10' }), false);
  assert.equal(packageRelease({ ...p, ref: 'refs/heads/feature' }), false);
  assert.equal(
    packageRelease({ ...p, eventName: 'pull_request', ref: 'refs/pull/1/merge' }),
    false,
  );
  assert.equal(packageRelease({ ...p, androidOnly: 'true' }), false);
  assert.equal(packageRelease({ ...p, ref: 'refs/tags/v0.8.11' }), true);
  assert.equal(packageRelease({ ...p, ref: 'refs/tags/v0.8.10' }), false);
  assert.equal(
    packageRelease({ ...p, eventName: 'workflow_dispatch', publishRelease: 'true' }),
    true,
  );
  assert.equal(
    packageRelease({ ...p, eventName: 'workflow_dispatch', publishRelease: 'false' }),
    false,
  );
});
