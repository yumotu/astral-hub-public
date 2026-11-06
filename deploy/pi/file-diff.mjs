import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';

// Compare bounded snapshots using Git's maintained line-diff implementation.
export async function compareFiles(before, after, path) {
  const dir = await mkdtemp(join(tmpdir(), 'astral-diff-'));
  try {
    const left = join(dir, 'before'),
      right = join(dir, 'after');
    await Promise.all([
      writeFile(left, before || Buffer.alloc(0), { mode: 0o600 }),
      writeFile(right, after, { mode: 0o600 }),
    ]);
    const result = await new Promise((resolve, reject) => {
      execFile(
        'git',
        [
          'diff',
          '--no-index',
          '--no-ext-diff',
          '--no-textconv',
          '--no-color',
          '--unified=3',
          '--',
          left,
          right,
        ],
        { maxBuffer: 2 * 1024 * 1024, timeout: 10000 },
        (error, stdout) => {
          if (error && error.code !== 1) reject(error);
          else resolve(stdout);
        },
      );
    });
    const lines = result.split('\n');
    let inHunk = false,
      added = 0,
      removed = 0;
    for (const line of lines) {
      if (line.startsWith('@@ ')) inHunk = true;
      else if (inHunk && line.startsWith('+')) added++;
      else if (inHunk && line.startsWith('-')) removed++;
    }
    const patch = lines
      .map((line) =>
        line.startsWith('diff --git ')
          ? `diff -- ${path}`
          : line.startsWith('--- ')
            ? `--- ${path} (修改前)`
            : line.startsWith('+++ ')
              ? `+++ ${path} (修改后)`
              : line,
      )
      .join('\n');
    return { added, removed, patch };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
