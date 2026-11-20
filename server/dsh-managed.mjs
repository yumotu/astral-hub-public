import { readFile } from 'node:fs/promises';
import { z } from 'zod';

export const managedDshSchema = z
  .object({
    version: z.literal(1),
    owner: z.string().uuid(),
    name: z.string().trim().min(1).max(80),
    origin: z.string().url(),
    account: z.string().min(1).max(254),
    password: z.string().min(12).max(1024),
    deviceId: z.string().uuid(),
    fingerprint: z.string().regex(/^[A-F0-9]{64}$/),
  })
  .strict();

// Only a root-provisioned local file can configure the managed server. This
// object is never returned to a browser or put in a model/tool catalogue.
export async function loadManagedDsh(path) {
  if (!path) return null;
  const bytes = await readFile(path);
  if (bytes.length > 16384) throw Error('DSH managed configuration is too large');
  return managedDshSchema.parse(JSON.parse(bytes.toString('utf8')));
}
