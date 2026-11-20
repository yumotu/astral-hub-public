import { z } from 'zod';
export const notificationTargetSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('mail'),
      mailbox: z.string().trim().min(1).max(200),
      uid: z.number().int().positive().max(0xffffffff),
      revision: z.string().regex(/^[a-f0-9]{64}$/),
      uidValidity: z.string().min(1).max(30),
    })
    .strict(),
  z.object({ type: z.literal('contact'), contactId: z.string().uuid() }).strict(),
  z.object({ type: z.literal('contacts') }).strict(),
]);
