import { createJiti } from 'jiti';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
// Match Pi 1.4.0's compatibility aliases; packages are allowed to depend on the
// host-provided pi-ai Type export without installing their own copy of Pi.
const load = createJiti(import.meta.url, {
  interopDefault: true,
  alias: {
    '@earendil-works/pi-ai': fileURLToPath(import.meta.resolve('@earendil-works/pi-ai/compat')),
    typebox: require.resolve('typebox'),
  },
});
export const loadCron = (path) => load.import(join(process.env.ASTRAL_CRON_PACKAGE, path));
