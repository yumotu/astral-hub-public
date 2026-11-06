import { z } from 'zod';
export const projectLabelSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .refine((s) => !/[\u0000-\u001f\u007f]/u.test(s), '显示名称不能含控制字符。')
      .nullable(),
  })
  .strict();

export function createProjectLabels(db) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS project_display_names(owner TEXT NOT NULL,target TEXT NOT NULL,project_id TEXT NOT NULL,name TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(owner,target,project_id))',
  );
  return {
    decorate(owner, target, projects) {
      const labels = new Map(
        db
          .prepare('SELECT project_id,name FROM project_display_names WHERE owner=? AND target=?')
          .all(owner, target)
          .map((r) => [r.project_id, r.name]),
      );
      return projects.map((p) =>
        labels.has(p.id) ? { ...p, originalName: p.name, name: labels.get(p.id) } : p,
      );
    },
    set(owner, target, id, name) {
      if (name === null)
        db.prepare(
          'DELETE FROM project_display_names WHERE owner=? AND target=? AND project_id=?',
        ).run(owner, target, id);
      else
        db.prepare(
          'INSERT INTO project_display_names VALUES(?,?,?,?,?) ON CONFLICT(owner,target,project_id) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at',
        ).run(owner, target, id, name, new Date().toISOString());
    },
  };
}
