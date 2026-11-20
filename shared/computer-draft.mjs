import { z } from 'zod';
const draft = z
  .object({
    file: z
      .object({
        path: z.string().min(1).max(500),
        content: z.string().max(262144),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        readOnly: z.boolean(),
        redacted: z.boolean().optional(),
      })
      .strict(),
    text: z.string().max(262144),
  })
  .strict();
export function readComputerDraft(storage, key) {
  try {
    return draft.parse(JSON.parse(storage.getItem(key)));
  } catch {
    return null;
  }
}

export function computerFileDraft(file, text) {
  const { path, content, sha256, readOnly, redacted } = file;
  return draft.parse({
    file: { path, content, sha256, readOnly, ...(redacted === undefined ? {} : { redacted }) },
    text,
  });
}
