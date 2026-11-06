import { z } from 'zod';
export const updateManifestSchema = z
  .object({
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    commit: z.string().regex(/^[a-f0-9]{40}$/),
    generatedAt: z.string().datetime(),
    notes: z.string().max(10000).default(''),
    assets: z
      .array(
        z
          .object({
            platform: z.enum(['mac-arm64', 'mac-x64', 'win-x64', 'android']),
            name: z
              .string()
              .regex(
                /^Astral-Hub-\d+\.\d+\.\d+-(?:mac-(?:arm64|x64)\.dmg|win-x64\.exe|android-debug\.apk)$/,
              ),
            bytes: z
              .number()
              .int()
              .positive()
              .max(512 * 1024 ** 2),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .min(1)
      .max(4),
  })
  .strict()
  .superRefine((m, ctx) => {
    if (new Set(m.assets.map((a) => a.platform)).size !== m.assets.length)
      ctx.addIssue({ code: 'custom', message: '更新平台重复。' });
    for (const a of m.assets) {
      const suffix = {
        'mac-arm64': 'mac-arm64.dmg',
        'mac-x64': 'mac-x64.dmg',
        'win-x64': 'win-x64.exe',
        android: 'android-debug.apk',
      }[a.platform];
      if (a.name !== `Astral-Hub-${m.version}-${suffix}`)
        ctx.addIssue({ code: 'custom', message: '安装包版本或平台不匹配。' });
    }
  });
export function newerVersion(candidate, current) {
  if (!/^\d+\.\d+\.\d+$/.test(candidate) || !/^\d+\.\d+\.\d+$/.test(current)) return false;
  const a = candidate.split('.').map(Number),
    b = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
