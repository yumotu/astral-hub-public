import test from 'node:test';
import assert from 'node:assert/strict';
import { pnpmEnvironment } from '../deploy/dsh/pnpm-environment.mjs';

test('DSH pnpm 11 uses supported config and persistent machine paths without changing HOME', () => {
  const env = pnpmEnvironment('/state/harness');
  assert.equal(env.pnpm_config_ignore_scripts, 'true');
  assert.equal(env.pnpm_config_confirm_modules_purge, 'false');
  assert.equal(env.pnpm_config_store_dir, '/state/harness/pnpm-store');
  assert.equal(env.pnpm_config_cache_dir, '/state/harness/pnpm-cache');
  assert.equal(env.pnpm_config_state_dir, '/state/harness/pnpm-state');
  for (const key of ['DATA', 'CACHE', 'STATE', 'CONFIG'])
    assert.ok(env[`XDG_${key}_HOME`].startsWith('/state/harness/'));
  assert.ok(!Object.keys(env).some((key) => key.startsWith('npm_config_')));
  assert.equal(env.HOME, undefined);
  assert.equal(env.PATH, undefined);
  assert.equal(env.pnpm_config_registry, undefined);
});
