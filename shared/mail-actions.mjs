import { z } from 'zod';

const path = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((v) => !/[\x00-\x1f\x7f]/.test(v), '文件夹名称不能包含控制字符');
const selection = {
  mailbox: path,
  uids: z
    .array(z.number().int().positive().max(0xffffffff))
    .min(1)
    .max(1000)
    .refine((v) => new Set(v).size === v.length, '邮件选择不能重复'),
};
export const mailOperationSchema = z
  .discriminatedUnion('action', [
    z.object({ action: z.literal('read'), ...selection }).strict(),
    z.object({ action: z.literal('unread'), ...selection }).strict(),
    z.object({ action: z.literal('move'), ...selection, destination: path }).strict(),
    z.object({ action: z.literal('trash'), ...selection }).strict(),
    z
      .object({ action: z.literal('restore'), ...selection, destination: path.default('INBOX') })
      .strict(),
    z.object({ action: z.literal('create-folder'), name: path }).strict(),
    z.object({ action: z.literal('rename-folder'), mailbox: path, name: path }).strict(),
    z
      .object({
        action: z.literal('organize'),
        mailbox: path,
        groups: z
          .array(
            z
              .object({
                destination: path,
                create: z.boolean().default(false),
                uids: selection.uids,
              })
              .strict(),
          )
          .min(1)
          .max(50),
      })
      .strict(),
  ])
  .refine((operation) => {
    if (operation.action !== 'organize') return true;
    const uids = operation.groups.flatMap((group) => group.uids);
    return (
      uids.length <= 1000 &&
      new Set(uids).size === uids.length &&
      new Set(operation.groups.map((group) => group.destination)).size === operation.groups.length
    );
  }, '同一邮件只能分到一个组，目标文件夹不能重复，一批最多1000封');
export const mailActionTitles = {
  read: '标记为已读',
  unread: '标记为未读',
  move: '移动邮件',
  trash: '移至回收站',
  restore: '恢复邮件',
  'create-folder': '新建文件夹',
  'rename-folder': '重命名文件夹',
  organize: '分类整理邮件',
};
