import { resolve } from 'node:path';

// pnpm 11 reads pnpm_config_*, not npm_config_*. Keep its machine state
// inside the writable persistent DSH home without changing the host HOME.
export function pnpmEnvironment(root) {
  return {
    pnpm_config_ignore_scripts: 'true',
    pnpm_config_store_dir: resolve(root, 'pnpm-store'),
    pnpm_config_cache_dir: resolve(root, 'pnpm-cache'),
    pnpm_config_state_dir: resolve(root, 'pnpm-state'),
    pnpm_config_confirm_modules_purge: 'false',
    XDG_DATA_HOME: resolve(root, 'xdg-data'),
    XDG_CACHE_HOME: resolve(root, 'xdg-cache'),
    XDG_STATE_HOME: resolve(root, 'xdg-state'),
    XDG_CONFIG_HOME: resolve(root, 'xdg-config'),
    CI: 'true',
  };
}
