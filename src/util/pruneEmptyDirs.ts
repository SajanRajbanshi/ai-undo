import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { isInside } from './paths';

/**
 * §6.9 / §8.4 — `git checkout` recreates parent directories when it restores a
 * file, but `unlink` never removes them. Rejecting a folder rename would
 * otherwise leave the renamed-to directory behind as an empty husk.
 *
 * Walks upward from each deleted path removing directories left empty, stopping
 * at the workspace root and never crossing it. Returns the directories removed.
 */
export async function pruneEmptyParents(
  root: string,
  deletedAbsPaths: readonly string[],
): Promise<string[]> {
  const rootResolved = path.resolve(root);
  const removed: string[] = [];
  const visited = new Set<string>();

  // Deepest first, so a nested chain (lib/a/b/c) collapses in one pass.
  const startDirs = [...new Set(deletedAbsPaths.map((p) => path.dirname(path.resolve(p))))].sort(
    (a, b) => b.length - a.length,
  );

  for (const start of startDirs) {
    let dir = start;
    for (;;) {
      const resolved = path.resolve(dir);
      // Never remove the workspace root itself, and never step outside it.
      if (resolved === rootResolved || !isInside(rootResolved, resolved)) break;
      // Only directories we already removed are worth skipping. Marking one
      // visited because it was *non-empty* is what used to leave a husk behind:
      // `lib` still holds `b` when the walk from `lib/a` reaches it, so it
      // breaks — and the later walk from `lib/b`, which would have found `lib`
      // empty, stopped at the visited marker instead.
      if (visited.has(resolved)) break;

      let entries: string[];
      try {
        entries = await fs.readdir(resolved);
      } catch {
        // Already gone, or unreadable. Either way there is nothing to prune.
        break;
      }
      if (entries.length > 0) break;

      try {
        await fs.rmdir(resolved);
        removed.push(resolved);
        visited.add(resolved);
      } catch {
        // A race or a permission problem. Leaving a stray empty directory is a
        // cosmetic failure; it must never abort a reject.
        break;
      }
      dir = path.dirname(resolved);
    }
  }

  return removed;
}
