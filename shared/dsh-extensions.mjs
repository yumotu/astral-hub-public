import { z } from 'zod';

const name = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(64);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
export const dshPackageName = z
  .string()
  .max(160)
  .regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/);
export const dshPackageSpec = z
  .string()
  .max(220)
  .regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/);
const resource = z
  .object({
    path: z
      .string()
      .min(1)
      .max(200)
      .refine(
        (p) =>
          !/[\\\x00-\x1f]/.test(p) &&
          p !== 'SKILL.md' &&
          p.split('/').every((s) => !!s && s !== '..' && !s.startsWith('.')),
      ),
    text: z.string().max(65536),
  })
  .strict();
const secretFields = z
  .record(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,79}$/),
    z
      .string()
      .max(4096)
      .refine((v) => !/[\r\n\x00]/.test(v)),
  )
  .refine((v) => Object.keys(v).length <= 24);
const https = z
  .string()
  .url()
  .max(2048)
  .refine((v) => {
    const u = new URL(v);
    return (
      !u.username &&
      !u.password &&
      !u.hash &&
      (u.protocol === 'https:' ||
        (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))
    );
  }, 'MCP 使用 HTTPS；HTTP 仅限目标主机回环地址。');
const mcp = z.discriminatedUnion('transport', [
  z
    .object({
      transport: z.literal('stdio'),
      command: z
        .string()
        .min(1)
        .max(512)
        .refine((v) => !/[\x00-\x1f]/.test(v)),
      args: z
        .array(
          z
            .string()
            .max(2048)
            .refine((v) => !v.includes('\x00')),
        )
        .max(40)
        .default([]),
      env: secretFields.default({}),
    })
    .strict(),
  z
    .object({
      transport: z.literal('streamable-http'),
      url: https,
      headers: secretFields.default({}),
    })
    .strict(),
]);

export const dshExtensionChange = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('skill-save'),
      name,
      markdown: z.string().min(1).max(60000),
      resources: z.array(resource).max(32).optional(),
      revision: revision.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('skill-state'),
      name,
      state: z.enum(['enabled', 'disabled', 'removed']),
      revision,
    })
    .strict(),
  z.object({ kind: z.literal('plugin-install'), spec: dshPackageSpec }).strict(),
  z
    .object({
      kind: z.literal('plugin-update'),
      name: dshPackageName,
      spec: dshPackageSpec,
      revision,
    })
    .strict(),
  z
    .object({
      kind: z.literal('plugin-state'),
      name: dshPackageName,
      state: z.enum(['enabled', 'disabled', 'removed']),
      revision,
    })
    .strict(),
  z
    .object({
      kind: z.literal('mcp-save'),
      name,
      config: mcp,
      revision: revision.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('mcp-state'),
      name,
      state: z.enum(['enabled', 'disabled', 'removed']),
      revision,
    })
    .strict(),
]);
export const dshExtensionRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('catalog') }).strict(),
  z.object({ action: z.literal('read-skill'), name }).strict(),
  z
    .object({ action: z.literal('prepare'), id: z.string().uuid(), change: dshExtensionChange })
    .strict(),
  z
    .object({ action: z.literal('commit'), id: z.string().uuid(), plan: z.string().uuid() })
    .strict(),
  z.object({ action: z.literal('discard'), plan: z.string().uuid() }).strict(),
  z.object({ action: z.literal('status'), id: z.string().uuid() }).strict(),
]);
export const dshExtensionLabels = {
  'skill-save': '保存技能',
  'skill-state': '更改技能状态',
  'plugin-install': '安装原生插件',
  'plugin-update': '更新原生插件',
  'plugin-state': '更改原生插件状态',
  'mcp-save': '保存 MCP 服务',
  'mcp-state': '更改 MCP 服务状态',
};
