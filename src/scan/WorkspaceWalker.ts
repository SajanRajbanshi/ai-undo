import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { Logger } from '../log';
import { nullLogger } from '../log';
import type { CancellationLike } from '../store/CheckpointStore';
import { toPosix } from '../util/paths';
import { AMBIGUOUS_DIRS, SOURCE_EXTENSIONS } from './defaults';
import type { IgnoreRules } from './IgnoreRules';

/**
 * §5.5.2 — the authoritative file enumeration.
 *
 * Removing git from file selection entirely is the resolution to §5.5: every
 * ignore source (the project's `.gitignore`, nested ones, `info/exclude`,
 * `core.excludesFile`) becomes irrelevant *by construction* rather than by
 * override, and file-selection policy lives in one testable place.
 */

/** A tree this large is almost certainly a denylist bug (§9.1). */
export const IMPLAUSIBLE_FILE_COUNT = 200_000;

export interface WalkStats {
  files: number;
  directories: number;
  prunedDirectories: number;
  /** Files skipped by the L3 size cap; drives the E8 notice. */
  oversized: { relPath: string; size: number }[];
  /** Nested repositories or submodules that were skipped (E3). */
  nestedRepos: string[];
  /** Ambiguous directories (bin/env/out/target) that appear to hold source (§17.1). */
  ambiguousWithSource: string[];
  durationMs: number;
  cancelled: boolean;
}

/** Directories read concurrently. Enough to keep an SSD queue busy. */
const DIR_CONCURRENCY = 16;
/** Oversized files worth remembering; the notice only names a few. */
const MAX_OVERSIZED_TRACKED = 50;

export class WorkspaceWalker {
  private stats: WalkStats = emptyStats();

  constructor(
    readonly root: string,
    private readonly rules: IgnoreRules,
    private readonly log: Logger = nullLogger,
  ) {}

  get lastWalkStats(): Readonly<WalkStats> {
    return this.stats;
  }

  /** Workspace-relative POSIX paths of every tracked-eligible file. */
  async walk(token?: CancellationLike): Promise<string[]> {
    const started = Date.now();
    const stats = emptyStats();
    const files: string[] = [];
    const ambiguousCandidates = new Set<string>();

    // Breadth-first by level, with each level read in bounded-parallel batches.
    // An explicit queue rather than recursion keeps a deep tree off the stack.
    let level: string[] = [this.root];
    while (level.length > 0) {
      if (token?.isCancellationRequested) break;
      const next: string[] = [];
      for (let i = 0; i < level.length; i += DIR_CONCURRENCY) {
        if (token?.isCancellationRequested) break;
        const batch = level.slice(i, i + DIR_CONCURRENCY);
        await Promise.all(
          batch.map((dir) => this.readDirectory(dir, next, files, stats, ambiguousCandidates)),
        );
      }
      level = next;
    }

    // §17.1 — probe the ambiguous directories once, after the walk, so the
    // decision never sits on the hot path.
    if (ambiguousCandidates.size > 0 && !token?.isCancellationRequested) {
      const candidates = [...ambiguousCandidates];
      const hasSource = await Promise.all(
        candidates.map((rel) => this.probeForSource(path.resolve(this.root, rel))),
      );
      stats.ambiguousWithSource = candidates.filter((_, i) => hasSource[i]).sort();
    }

    stats.files = files.length;
    stats.durationMs = Date.now() - started;
    stats.cancelled = token?.isCancellationRequested ?? false;
    this.stats = stats;

    if (stats.files > IMPLAUSIBLE_FILE_COUNT) {
      this.log.warn(
        `Walk found ${stats.files} eligible files, above the ${IMPLAUSIBLE_FILE_COUNT} plausibility limit. ` +
          'This almost always means a directory that should be excluded is not. Check lfct.exclude.',
      );
    }
    this.log.debug(
      `Walk: ${stats.files} files, ${stats.directories} dirs, ` +
        `${stats.prunedDirectories} pruned, ${stats.durationMs}ms`,
    );

    files.sort();
    return files;
  }

  private async readDirectory(
    absDir: string,
    next: string[],
    files: string[],
    stats: WalkStats,
    ambiguousCandidates: Set<string>,
  ): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch (err) {
      // Permission denied, or it vanished mid-walk. The reconciliation sweep is
      // authoritative and will see it next time; never abort the walk.
      this.log.debug(`readdir failed for ${absDir}: ${String(err)}`);
      return;
    }
    stats.directories++;

    // E3 — a nested repository or submodule. `git add` treats it as a gitlink
    // and will not descend, so tracking anything inside it would be a lie.
    if (absDir !== this.root && entries.some((e) => e.name === '.git')) {
      stats.nestedRepos.push(toPosix(path.relative(this.root, absDir)));
      stats.prunedDirectories++;
      return;
    }

    const sizeChecks: Promise<void>[] = [];

    for (const entry of entries) {
      const abs = path.join(absDir, entry.name);

      // E11 — track the link itself, never follow it. `isSymbolicLink` covers
      // links to directories too, so this is also what keeps the walk from
      // wandering out of the work tree.
      if (entry.isSymbolicLink()) {
        const rel = toPosix(path.relative(this.root, abs));
        if (this.rules.isTrackedRel(rel)) files.push(rel);
        continue;
      }

      if (entry.isDirectory()) {
        if (this.rules.shouldPruneDir(abs)) {
          stats.prunedDirectories++;
          if (AMBIGUOUS_DIRS.includes(entry.name)) {
            ambiguousCandidates.add(toPosix(path.relative(this.root, abs)));
          }
          continue;
        }
        // The prune test happens *before* descending. That is the whole
        // performance story: node_modules costs one string comparison rather
        // than 60k stats.
        next.push(abs);
        continue;
      }

      if (!entry.isFile()) continue;

      const rel = toPosix(path.relative(this.root, abs));
      if (!this.rules.isTrackedRel(rel)) continue;

      // L3 is the only layer that needs a stat, so it runs last and only on
      // files that already survived everything else.
      sizeChecks.push(
        this.rules.isWithinSizeCap(abs, rel).then((result) => {
          if (result.withinCap) {
            files.push(rel);
          } else if (result.size !== undefined && stats.oversized.length < MAX_OVERSIZED_TRACKED) {
            // E8 — the gap must not be silent.
            stats.oversized.push({ relPath: rel, size: result.size });
          }
        }),
      );
    }

    await Promise.all(sizeChecks);
  }

  /** Shallow: one readdir, no descent. A hint for a one-time notice, not a decision. */
  private async probeForSource(absDir: string): Promise<boolean> {
    try {
      const entries = await fs.readdir(absDir, { withFileTypes: true });
      return entries.some(
        (e) => e.isFile() && SOURCE_EXTENSIONS.includes(path.extname(e.name).toLowerCase()),
      );
    } catch {
      return false;
    }
  }
}

function emptyStats(): WalkStats {
  return {
    files: 0,
    directories: 0,
    prunedDirectories: 0,
    oversized: [],
    nestedRepos: [],
    ambiguousWithSource: [],
    durationMs: 0,
    cancelled: false,
  };
}
