import { z } from 'zod';

const label = z.string().min(1).max(300);
const nativeId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const modelId = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[^\x00-\x1f\x7f]+$/);
export const dshModelSelection = z
  .object({
    provider: modelId,
    model: modelId,
    reasoningEffort: modelId.optional(),
  })
  .strip();
export const dshModelCatalog = z
  .object({
    default: dshModelSelection,
    groups: z
      .array(
        z
          .object({
            id: modelId,
            name: label,
            models: z
              .array(
                z
                  .object({
                    id: modelId,
                    name: label,
                    reasoning: z
                      .object({
                        efforts: z
                          .array(
                            z
                              .object({
                                id: modelId,
                                name: label,
                                description: z.string().max(4000).optional(),
                              })
                              .strip(),
                          )
                          .max(30),
                        defaultEffort: modelId.optional(),
                      })
                      .strip()
                      .optional(),
                  })
                  .strip(),
              )
              .max(1000),
          })
          .strip(),
      )
      .max(100),
  })
  .strip();
export const dshPermissionOption = z
  .object({ value: nativeId, name: label, description: z.string().max(4000).optional() })
  .strip();
export const dshPermissions = z
  .object({
    currentValue: nativeId,
    options: z.array(dshPermissionOption).max(50).optional(),
  })
  .strip();
export const dshSkillCatalog = z
  .object({
    skills: z
      .array(
        z
          .object({
            name: z
              .string()
              .min(1)
              .max(200)
              .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
            description: z.string().max(8000),
            modelInvocable: z.boolean(),
          })
          .strip(),
      )
      .max(1000),
  })
  .strip();
export const dshTerminalEnvironment = z
  .object({
    maxInputBytes: z
      .number()
      .int()
      .positive()
      .max(1024 * 1024),
    maxCols: z.number().int().positive().max(1000),
    maxRows: z.number().int().positive().max(1000),
  })
  .strip();
export const dshTerminalInfo = z
  .object({
    id: z.string().uuid(),
    title: z.string().max(300),
    state: z.enum(['running', 'exited', 'failed']),
    cols: z.number().int().positive().max(1000),
    rows: z.number().int().positive().max(1000),
    exitCode: z.number().int().nullable(),
    controllerId: z.string().max(200).optional(),
  })
  .strip();
export function dshPermissionLabel(value, fallback) {
  return (
    { 'read-only': '待审核', 'workspace-write': '工作区', 'danger-full-access': '完全权限' }[
      value
    ] ||
    fallback ||
    value
  );
}
