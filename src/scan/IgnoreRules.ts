import * as fs from 'node:fs/promises';
import picomatch from 'picomatch';

import type { LfctConfig } from '../config';
import { basename, dirnamePosix, isInside, segments, toRelPosix } from '../util/paths';
import {
  L1_DIRS,
  L1_FILES,
  L2_DIRS,
  L2_DIR_GLOBS,
  L2_FILE_GLOBS,
  L2_PATH_GLOBS,
} from './defaults';

/**
 * §7.2 — the denylist matcher.
 *
 * `isTracked` runs on every filesystem event in the workspace. During an
 * `npm install` that is tens of thousands of calls per second, so it must be
 * synchronous, allocation-light, and never stat (P2). Everything that needs a
 * stat lives in `isWithinSizeCap`, which only the walker calls.
 */

type Matcher = (input: string) => boolean;

/** Bounded so a long session in a huge tree cannot grow this without limit. */
const DIR_CACHE_LIMIT = 8192;

export interface SizeCapResult {
  withinCap: boolean;
  /** Byte size, when it could be determined. Used for the E8 notice. */
  size?: number;
}

export class IgnoreRules {
  private readonly l1Dirs: Set<string>;
  private readonly l1Files: Set<string>;
  private readonly l2Dirs: Set<string>;
  private readonly userExcludeDirs: Set<string>;

  private readonly l2DirGlob: Matcher;
  private readonly l2FileGlob: Matcher;
  private readonly l2PathGlob: Matcher;
  private readonly userExcludeGlob: Matcher;
  private readonly includeGlob: Matcher;

  /** Static (glob-free) prefixes of the include patterns; see shouldPruneDir. */
  private readonly includePrefixes: string[];
  private readonly hasUnanchoredInclude: boolean;

  private readonly maxBytes: number;
  private readonly excludedAbsRoots: string[];

  /** Memoizes the directory portion of a path, which repeats constantly. */
  private readonly dirCache = new Map<string, boolean>();

  constructor(
    readonly root: string,
    config: LfctConfig,
    /** Extension storage. Never tracked: we must sit outside our own blast radius (§5.3). */
    storagePath?: string,
  ) {
    const { dirs: userDirs, globs: userGlobs } = partitionPatterns(config.exclude);
    const includePatterns = config.include.filter((p) => p.trim().length > 0);

    this.l1Dirs = new Set(L1_DIRS);
    this.l1Files = new Set(L1_FILES);
    this.l2Dirs = new Set(L2_DIRS);
    this.userExcludeDirs = new Set(userDirs);

    this.l2DirGlob = compile(L2_DIR_GLOBS);
    this.l2FileGlob = compile(L2_FILE_GLOBS);
    this.l2PathGlob = compile(L2_PATH_GLOBS);
    this.userExcludeGlob = compile(userGlobs);
    this.includeGlob = compile(expandBareNames(includePatterns));

    this.includePrefixes = includePatterns.map(staticPrefix).filter((p) => p.length > 0);
    this.hasUnanchoredInclude = includePatterns.some((p) => staticPrefix(p).length === 0);

    this.maxBytes = Math.max(1, Math.round(config.maxFileSizeMB * 1024 * 1024));
    this.excludedAbsRoots = storagePath ? [storagePath] : [];
  }

  /**
   * Hot path. `absPath` is a native absolute path; anything outside the
   * workspace is not our business.
   */
  isTracked(absPath: string): boolean {
    // §5.3 — our own storage must never be tracked, or our writes would feed
    // our own watcher.
    for (const excluded of this.excludedAbsRoots) {
      if (isInside(excluded, absPath)) return false;
    }
    const rel = toRelPosix(this.root, absPath);
    if (rel === undefined) return false;
    return this.isTrackedRel(rel);
  }

  /** Same decision, for a path already known to be workspace-relative POSIX. */
  isTrackedRel(relPath: string): boolean {
    const parent = dirnamePosix(relPath);
    if (parent.length > 0 && this.isDirExcluded(parent)) return false;

    const name = basename(relPath);
    if (this.l1Files.has(name)) return false;

    // L4 — include wins over L2 and L3, never over L1.
    if (this.matchesInclude(relPath)) return true;

    if (this.l2FileGlob(name)) return false;
    if (this.l2PathGlob(relPath)) return false;
    if (this.userExcludeGlob(relPath) || this.userExcludeGlob(name)) return false;

    return true;
  }

  /**
   * §5.5.2 — the walker calls this *before* descending. Pruning at the
   * directory level is what makes a 60k-file `node_modules` cost one `readdir`
   * and one string comparison instead of 60k stats.
   */
  shouldPruneDir(absDirPath: string): boolean {
    for (const excluded of this.excludedAbsRoots) {
      if (isInside(excluded, absDirPath)) return true;
    }
    const rel = toRelPosix(this.root, absDirPath);
    if (rel === undefined) return false;
    return this.shouldPruneDirRel(rel);
  }

  shouldPruneDirRel(relDirPath: string): boolean {
    const cached = this.dirCache.get(relDirPath);
    if (cached !== undefined) return cached;
    const result = this.computeDirPrune(relDirPath);
    if (this.dirCache.size >= DIR_CACHE_LIMIT) this.dirCache.clear();
    this.dirCache.set(relDirPath, result);
    return result;
  }

  private computeDirPrune(relDirPath: string): boolean {
    const parts = segments(relDirPath);
    if (parts.length === 0) return false;

    // L1 first: not overridable, so nothing below can rescue it.
    for (const part of parts) {
      if (this.l1Dirs.has(part)) return true;
    }

    // L4 — if anything the user re-included could live under this directory,
    // we must descend into it.
    if (this.includeCouldMatchUnder(relDirPath)) return false;

    for (const part of parts) {
      if (this.l2Dirs.has(part) || this.userExcludeDirs.has(part) || this.l2DirGlob(part)) return true;
    }
    if (this.l2PathGlob(relDirPath) || this.userExcludeGlob(relDirPath)) return true;

    const name = parts[parts.length - 1];
    if (this.userExcludeGlob(name)) return true;

    return false;
  }

  /** True when any ancestor directory of `relPath` is pruned. */
  private isDirExcluded(relDirPath: string): boolean {
    return this.shouldPruneDirRel(relDirPath);
  }

  private matchesInclude(relPath: string): boolean {
    if (this.includePrefixes.length === 0 && !this.hasUnanchoredInclude) return false;
    return this.includeGlob(relPath);
  }

  /**
   * Whether an include pattern could match something inside this directory.
   * A pattern's static prefix (everything before its first glob character)
   * settles it: `bin/**` has prefix `bin`, so `bin` and everything under it
   * stays walkable. A pattern that begins with a glob has no prefix and could
   * match anywhere, so it disables L2 pruning entirely — the user's choice, and
   * L1 still holds.
   */
  private includeCouldMatchUnder(relDirPath: string): boolean {
    if (this.hasUnanchoredInclude) return true;
    for (const prefix of this.includePrefixes) {
      if (prefix === relDirPath) return true;
      if (prefix.startsWith(relDirPath + '/')) return true;
      if (relDirPath.startsWith(prefix + '/')) return true;
    }
    return false;
  }

  /** L3. Async because it stats; only ever called on files that survived L1/L2/L4. */
  async isWithinSizeCap(absPath: string, relPath?: string): Promise<SizeCapResult> {
    const rel = relPath ?? toRelPosix(this.root, absPath);
    // The size cap is part of the computed denylist, so `lfct.include` overrides
    // it exactly as it overrides L2.
    if (rel !== undefined && this.matchesInclude(rel)) return { withinCap: true };
    try {
      const st = await fs.lstat(absPath);
      return { withinCap: st.size <= this.maxBytes, size: st.size };
    } catch {
      // Vanished between enumeration and stat. Treat as not tracked; the next
      // reconciliation sweep is authoritative anyway.
      return { withinCap: false };
    }
  }

  isSizeWithinCap(size: number): boolean {
    return size <= this.maxBytes;
  }

  get maxFileBytes(): number {
    return this.maxBytes;
  }
}

/**
 * A pattern without `/` names a path segment (`dist`, `*.pyc`); one with `/` is
 * matched against the workspace-relative path. This mirrors how people already
 * expect `.gitignore`-style lists to read.
 */
function partitionPatterns(patterns: readonly string[]): { dirs: string[]; globs: string[] } {
  const dirs: string[] = [];
  const globs: string[] = [];
  for (const raw of patterns) {
    const pattern = raw.trim().replace(/\/+$/, '');
    if (pattern.length === 0) continue;
    if (!pattern.includes('/') && !hasGlobChars(pattern)) {
      dirs.push(pattern);
    } else {
      globs.push(pattern);
      if (!pattern.includes('/')) continue;
      // Also match the pattern anywhere in the tree, the way gitignore does.
      if (!pattern.startsWith('**/')) globs.push(`**/${pattern}`);
    }
  }
  return { dirs, globs };
}

/** `lfct.include` entries get the same anywhere-in-tree treatment. */
function expandBareNames(patterns: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of patterns) {
    const pattern = raw.trim().replace(/\/+$/, '');
    if (pattern.length === 0) continue;
    out.push(pattern);
    if (!pattern.startsWith('**/')) out.push(`**/${pattern}`);
    if (!hasGlobChars(pattern)) {
      // `bin` should re-include everything under `bin`, not just a file
      // literally named `bin`.
      out.push(`${pattern}/**`, `**/${pattern}/**`);
    }
  }
  return out;
}

function hasGlobChars(pattern: string): boolean {
  return /[*?[\]{}!()]/.test(pattern);
}

/** Everything before the first glob character, trimmed to a path boundary. */
export function staticPrefix(pattern: string): string {
  const trimmed = pattern.trim().replace(/^\.\//, '').replace(/\/+$/, '');
  const globIndex = trimmed.search(/[*?[\]{}!()]/);
  const head = globIndex === -1 ? trimmed : trimmed.slice(0, globIndex);
  const lastSlash = head.lastIndexOf('/');
  if (globIndex === -1) return head;
  return lastSlash === -1 ? '' : head.slice(0, lastSlash);
}

function compile(patterns: readonly string[]): Matcher {
  if (patterns.length === 0) return () => false;
  // Compiled once at construction: `isTracked` must not build matchers on the
  // hot path.
  const isMatch = picomatch([...patterns], { dot: true, nocase: false });
  return (input: string) => isMatch(input);
}
