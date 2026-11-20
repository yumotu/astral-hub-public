import { z } from 'zod';
export const chatMessageSchema = z
  .object({
    id: z.string().uuid(),
    conversationId: z.string().uuid(),
    role: z.enum(['user', 'assistant', 'system']),
    content: z.string().min(1).max(20000),
    createdAt: z.string().datetime(),
  })
  .strict();
export const chatEntrySchema = z
  .object({
    id: z.string().uuid(),
    deleted: z.boolean(),
    data: chatMessageSchema.nullable(),
  })
  .strict()
  .superRefine((e, ctx) => {
    if (e.deleted ? e.data !== null : !e.data || e.data.id !== e.id)
      ctx.addIssue({ code: 'custom', message: '聊天记录格式不正确' });
  });
