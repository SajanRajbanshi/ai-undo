import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { Logger } from '../log';
import { nullLogger } from '../log';
import { toAbs } from '../util/paths';
import { pruneEmptyParents } from '../util/pruneEmptyDirs';
import { Git, GitError, literalPathspec, pathspecStdin, type GitVersion } from './git';
import {
  initStore,
  SHADOW_DIR_NAME,
  writeMeta,
  type StoreMeta,
} from './init';
import { makeAddedFilePatch } from './patch';

/**
 * §7.1 — sole owner of the shadow repository. No other module shells out to
 * git; that is what keeps the serialization invariant in `git.ts` enforceable
 * rather than merely conventional.
 */

export type FileStatusCode = 'M' | 'A' | 'D';

export interface FileStatus {
  relPath: string;
  status: FileStatusCode;
}

/** One path's entry in the baseline: what `git ls-files --stage` reports for it. */
export interface BaselineEntry {
  mode: string;
  oid: string;
}

export interface RestoreOutcome {
  restored: string[];
  /** E13 — per-file failures are reported, never swallowed and never fatal. */
  failures: { relPath: string; message: string }[];
  /** Directories removed because rejecting an added file emptied them (§6.9). */
  prunedDirs: string[];
}

export interface CancellationLike {
  isCancellationRequested: boolean;
}

export interface ProgressLike {
  report(value: { increment?: number; message?: string }): void;
}

/** Paths per `git add` invocation during the initial baseline. */
const BASELINE_CHUNK_SIZE = 2000;

/**
 * Context lines for the patch view. Large enough that every real file comes out
 * as a single hunk covering the whole thing: reviewing a change means seeing
 * where it sits, not just the three lines either side of it.
 */
const FULL_CONTEXT = 1_000_000;
/** Past this many lines, full context stops helping and starts hurting. */
const MAX_FULL_CONTEXT_LINES = 20_000;
/** Still generous — a screenful either side rather than git's default three. */
const FALLBACK_CONTEXT = 25;

export class CheckpointStore {
  private headExists = false;

  private constructor(
    private readonly git: Git,
    readonly storagePath: string,
    readonly worktree: string,
    private meta: StoreMeta,
    private readonly log: Logger,
    readonly recoveredStaleLock: boolean,
  ) {}

  static async open(opts: {
    storagePath: string;
    worktree: string;
    version: GitVersion;
    extensionVersion: string;
    fsMonitor?: boolean;
    log?: Logger;
    gitPath?: string;
  }): Promise<CheckpointStore> {
    const log = opts.log ?? nullLogger;
    const { git, meta, recoveredStaleLock } = await initStore({
      storagePath: opts.storagePath,
      worktree: opts.worktree,
      version: opts.version,
      extensionVersion: opts.extensionVersion,
      fsMonitor: opts.fsMonitor ?? false,
      log,
      gitPath: opts.gitPath,
    });
    const store = new CheckpointStore(
      git,
      opts.storagePath,
      opts.worktree,
      meta,
      log,
      recoveredStaleLock,
    );
    await store.refreshHeadState();
    return store;
  }

  get gitDir(): string {
    return path.join(this.storagePath, SHADOW_DIR_NAME);
  }

  get metadata(): Readonly<StoreMeta> {
    return this.meta;
  }

  /** True once the initial baseline commit exists. Reject stays disabled until then (§8.1). */
  hasBaseline(): boolean {
    return this.headExists;
  }

  private async refreshHeadState(): Promise<void> {
    const r = await this.git.run(['rev-parse', '--verify', '--quiet', 'HEAD'], {
      allowExit: [1],
    });
    this.headExists = r.code === 0 && r.stdout.toString('utf8').trim().length > 0;
  }

  // ---------------------------------------------------------------- baseline

  /**
   * §8.2 — the baseline must be eager. The watcher fires *after* a write lands,
   * at which point the previous content is already gone from disk, so lazy
   * snapshotting can never protect the first change to a file.
   */
  async createInitialBaseline(
    relPaths: string[],
    progress?: ProgressLike,
    token?: CancellationLike,
  ): Promise<void> {
    const total = Math.max(relPaths.length, 1);
    let done = 0;

    for (let i = 0; i < relPaths.length; i += BASELINE_CHUNK_SIZE) {
      if (token?.isCancellationRequested) {
        this.log.warn('Initial baseline cancelled; store left without a HEAD.');
        return;
      }
      const chunk = relPaths.slice(i, i + BASELINE_CHUNK_SIZE);
      await this.addPaths(chunk);
      done += chunk.length;
      progress?.report({
        increment: (chunk.length / total) * 100,
        message: `${done} / ${relPaths.length} files`,
      });
    }

    if (token?.isCancellationRequested) return;

    await this.commit('baseline');
    await this.refreshHeadState();
    this.log.info(`Initial baseline created with ${relPaths.length} files.`);
  }

  /**
   * §7.1 Accept. Advances the baseline for the given paths. Never writes to the
   * work tree — that asymmetry is the whole design (§1.1).
   */
  async commitPaths(relPaths: string[], reason: string): Promise<void> {
    if (relPaths.length === 0) return;

    const valid = await this.validPathspecs(relPaths);
    if (valid.length === 0) {
      this.log.debug(`commitPaths(${reason}): nothing to stage.`);
      return;
    }

    await this.addPaths(valid);

    if (this.headExists && !(await this.hasStagedChanges())) {
      this.log.debug(`commitPaths(${reason}): index already matches HEAD, skipping commit.`);
      return;
    }

    await this.commit(reason);
    await this.refreshHeadState();
    this.meta = { ...this.meta, lastAcceptAt: new Date().toISOString() };
    await writeMeta(this.storagePath, this.meta);
    this.log.info(`Baseline advanced for ${valid.length} path(s) [${reason}].`);
  }

  /**
   * `git add` errors out when a pathspec matches neither the work tree nor the
   * index, which happens whenever a file is created and removed again between
   * detection and accept. Filter first rather than parsing git's complaint.
   *
   * The common case — every path exists on disk — costs zero extra git calls.
   */
  private async validPathspecs(relPaths: string[]): Promise<string[]> {
    const existing: string[] = [];
    const missing: string[] = [];
    await Promise.all(
      relPaths.map(async (rel) => {
        try {
          await fs.lstat(toAbs(this.worktree, rel));
          existing.push(rel);
        } catch {
          missing.push(rel);
        }
      }),
    );
    if (missing.length === 0) return existing;

    // A missing path is still a valid pathspec if it is tracked — `git add`
    // stages the deletion. `git ls-files` has no --pathspec-from-file, so this
    // reads the whole index; it only happens when something was deleted.
    const tracked = await this.trackedPaths();
    for (const rel of missing) {
      if (tracked.has(rel)) existing.push(rel);
    }
    return existing;
  }

  private async addPaths(relPaths: string[]): Promise<void> {
    // -f bypasses every ignore source; -A stages deletions for matched paths.
    // Paths travel over stdin NUL-separated, so there is no argv limit and no
    // quoting to get wrong (§5.5.1).
    await this.git.run(
      ['add', '-f', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'],
      { stdin: pathspecStdin(relPaths) },
    );
  }

  private async commit(reason: string): Promise<void> {
    await this.git.run([
      'commit',
      '--quiet',
      '--allow-empty',
      '--no-verify',
      '--no-gpg-sign',
      '-m',
      reason,
    ]);
  }

  private async hasStagedChanges(): Promise<boolean> {
    const r = await this.git.run(['diff', '--cached', '--quiet', 'HEAD'], { allowExit: [1] });
    return r.code === 1;
  }

  /**
   * Advances the baseline for one path to arbitrary content, without touching
   * the work tree. This is what makes per-hunk Accept meaningful: the file on
   * disk already has every hunk applied, so accepting one hunk means moving the
   * baseline forward by exactly that hunk and leaving the rest pending.
   *
   * Writes the blob directly and stages it via `update-index`, so the work tree
   * is never involved — consistent with Accept never writing to disk (§1.1).
   */
  async commitContent(relPath: string, content: string, reason: string): Promise<void> {
    const hashed = await this.git.run(['hash-object', '-w', '--stdin'], {
      stdin: Buffer.from(content, 'utf8'),
    });
    const sha = hashed.stdout.toString('utf8').trim();
    if (!/^[0-9a-f]{40,64}$/.test(sha)) {
      throw new Error(`git hash-object returned an unexpected object id: ${sha}`);
    }

    // Preserve the recorded file mode; losing the executable bit on a script
    // would be a silent, annoying corruption of the baseline.
    const mode = await this.fileMode(relPath);
    await this.git.run(['update-index', '--add', '--cacheinfo', `${mode},${sha},${relPath}`]);

    if (!(await this.hasStagedChanges())) return;
    await this.commit(reason);
    await this.refreshHeadState();
    this.meta = { ...this.meta, lastAcceptAt: new Date().toISOString() };
    await writeMeta(this.storagePath, this.meta);
    this.log.info(`Baseline advanced for ${relPath} [${reason}].`);
  }

  private async fileMode(relPath: string): Promise<string> {
    try {
      const out = await this.git.text(['ls-files', '-s', '-z', '--', literalPathspec(relPath)]);
      const match = /^(\d{6}) /.exec(out);
      if (match) return match[1];
    } catch {
      /* not in the index yet */
    }
    return '100644';
  }

  /**
   * Object ids for work-tree files, hashed the way `git add` would store them
   * here, so they compare directly with `baselineEntries`. Nothing is written
   * to the object store.
   *
   * `null` means the file does not exist. A path that is not a regular file is
   * left out, and so is one `--stdin-paths` cannot carry (a newline, or a
   * leading quote it would unquote): an id that might not be comparable is
   * worse than no id.
   */
  async hashWorktreeFiles(relPaths: readonly string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    const regular: string[] = [];
    await Promise.all(
      relPaths.map(async (rel) => {
        try {
          const st = await fs.lstat(toAbs(this.worktree, rel));
          if (st.isFile() && !/[\r\n]/.test(rel) && !rel.startsWith('"')) regular.push(rel);
        } catch {
          out.set(rel, null);
        }
      }),
    );
    if (regular.length === 0) return out;

    try {
      const ids = (
        await this.git.text(['hash-object', '--stdin-paths'], { stdin: regular.join('\n') + '\n' })
      )
        .split('\n')
        .filter((line) => line.length > 0);
      if (ids.length !== regular.length) {
        throw new Error(`expected ${regular.length} object ids, got ${ids.length}`);
      }
      regular.forEach((rel, i) => out.set(rel, ids[i]));
    } catch (err) {
      // One file vanishing between the lstat and the hash fails the whole
      // batch. Retry singly so it costs only that file.
      this.log.debug(`Batch hash failed, retrying individually: ${describeError(err)}`);
      for (const rel of regular) {
        try {
          out.set(rel, (await this.git.text(['hash-object', '--', rel])).trim());
        } catch {
          /* unknown, which callers treat as "not comparable" */
        }
      }
    }
    return out;
  }

  /** Baseline entries for the given paths. A path absent from the result is not in the baseline. */
  async baselineEntries(relPaths: readonly string[]): Promise<Map<string, BaselineEntry>> {
    const out = new Map<string, BaselineEntry>();
    const wanted = new Set(relPaths);
    if (!this.headExists || wanted.size === 0) return out;

    // `ls-files` has no --pathspec-from-file, so read the whole index, as
    // `trackedPaths` does. Each record is `<mode> <oid> <stage>\t<path>`.
    for (const record of await this.git.nulList(['ls-files', '--stage', '-z'])) {
      const tab = record.indexOf('\t');
      if (tab === -1) continue;
      const relPath = record.slice(tab + 1);
      if (!wanted.has(relPath)) continue;
      const [mode, oid] = record.slice(0, tab).split(' ');
      if (mode && oid) out.set(relPath, { mode, oid });
    }
    return out;
  }

  /**
   * Moves the baseline for each path to a recorded entry, or out of the
   * baseline for `null`, without touching the work tree. Like `commitContent`,
   * but for content the store already holds — typically an earlier baseline.
   */
  async setBaselineEntries(
    entries: readonly { relPath: string; entry: BaselineEntry | null }[],
    reason: string,
  ): Promise<void> {
    if (entries.length === 0) return;

    const info = entries
      .filter((e) => e.entry !== null)
      .map((e) => `${e.entry!.mode} ${e.entry!.oid}\t${e.relPath}\0`)
      .join('');
    if (info.length > 0) {
      await this.git.run(['update-index', '-z', '--index-info'], {
        stdin: Buffer.from(info, 'utf8'),
      });
    }
    const removals = entries.filter((e) => e.entry === null).map((e) => e.relPath);
    if (removals.length > 0) {
      // `--stdin` must come last: options only apply to paths read after them.
      await this.git.run(['update-index', '-z', '--force-remove', '--stdin'], {
        stdin: Buffer.from(removals.map((rel) => `${rel}\0`).join(''), 'utf8'),
      });
    }

    if (this.headExists && !(await this.hasStagedChanges())) return;
    await this.commit(reason);
    await this.refreshHeadState();
    this.log.info(`Baseline set for ${entries.length} path(s) [${reason}].`);
  }

  // ------------------------------------------------------------------ status

  /**
   * Modified and deleted paths. Tracked paths only, so no ignore rule can
   * participate — that is precisely why `git status` is never used (§7.4).
   */
  async diffNameStatus(): Promise<FileStatus[]> {
    if (!this.headExists) return [];
    const raw = await this.git.text([
      'diff',
      '--name-status',
      '--no-renames',
      '--no-ext-diff',
      '-z',
      'HEAD',
    ]);
    return parseNameStatusZ(raw);
  }

  /** The index, which after a force-add contains `.env` and every other ignored-but-tracked path. */
  async trackedPaths(): Promise<Set<string>> {
    const list = await this.git.nulList(['ls-files', '-z']);
    return new Set(list);
  }

  /**
   * §7.4 — the union of git's view of tracked paths and our own enumeration.
   * `onDiskPaths` comes from the WorkspaceWalker and is already denylist-pruned,
   * so the set difference below yields exactly the created files, including
   * ones the project's `.gitignore` would have hidden.
   */
  async status(onDiskPaths: readonly string[]): Promise<FileStatus[]> {
    return (await this.statusWithTracked(onDiskPaths)).statuses;
  }

  /**
   * As `status`, but also hands back the baseline's path set. The caller needs
   * it for quick-diff eligibility, and computing it here avoids a second
   * `ls-files` on the most frequent operation in the extension.
   */
  async statusWithTracked(
    onDiskPaths: readonly string[],
  ): Promise<{ statuses: FileStatus[]; tracked: Set<string> }> {
    if (!this.headExists) return { statuses: [], tracked: new Set() };

    const [changed, tracked] = await Promise.all([this.diffNameStatus(), this.trackedPaths()]);

    const added: FileStatus[] = [];
    for (const rel of onDiskPaths) {
      if (!tracked.has(rel)) added.push({ relPath: rel, status: 'A' });
    }

    // A tracked path that the walker no longer considers eligible (excluded by
    // a config change, or grown past the size cap) would otherwise sit in the
    // list forever with no way to resolve it. Keep reporting it — the user can
    // Accept to drop it — but never invent an 'A' for it.
    const statuses = [...changed, ...added];
    statuses.sort((a, b) => a.relPath.localeCompare(b.relPath));
    return { statuses, tracked };
  }

  // ----------------------------------------------------------------- restore

  /**
   * §7.1 Reject. The one operation that mutates the work tree, and the reason
   * losing a baseline means losing the ability to recover.
   */
  async restore(relPaths: string[]): Promise<RestoreOutcome> {
    const outcome: RestoreOutcome = { restored: [], failures: [], prunedDirs: [] };
    if (relPaths.length === 0) return outcome;

    const tracked = await this.trackedPaths();
    const inBaseline = relPaths.filter((p) => tracked.has(p));
    const notInBaseline = relPaths.filter((p) => !tracked.has(p));

    // 'M' and 'D': git owns this. `checkout` resets index and work tree
    // together, so the file leaves the pending list as soon as it is written.
    if (inBaseline.length > 0) {
      try {
        await this.git.run(
          ['checkout', 'HEAD', '--pathspec-from-file=-', '--pathspec-file-nul'],
          { stdin: pathspecStdin(inBaseline) },
        );
        outcome.restored.push(...inBaseline);
      } catch (err) {
        // A batch failure (a read-only file, say) must not lose the other
        // paths, so fall back to one checkout per path to isolate the blame.
        this.log.warn(`Batch restore failed, retrying individually: ${describeError(err)}`);
        for (const rel of inBaseline) {
          try {
            await this.git.run(['checkout', 'HEAD', '--', literalPathspec(rel)]);
            outcome.restored.push(rel);
          } catch (e) {
            outcome.failures.push({ relPath: rel, message: describeError(e) });
          }
        }
      }
    }

    // 'A': not in the baseline, so restoring means the file should not exist.
    const unlinked: string[] = [];
    for (const rel of notInBaseline) {
      const abs = toAbs(this.worktree, rel);
      try {
        await fs.rm(abs, { force: true });
        outcome.restored.push(rel);
        unlinked.push(abs);
      } catch (e) {
        outcome.failures.push({ relPath: rel, message: describeError(e) });
      }
    }

    // §6.9 / E10d — `unlink` leaves the directory behind. Without this,
    // rejecting a folder rename leaves the renamed-to directory as an empty
    // husk.
    if (unlinked.length > 0) {
      outcome.prunedDirs = await pruneEmptyParents(this.worktree, unlinked);
    }

    return outcome;
  }

  // ---------------------------------------------------------------- contents

  /** Baseline bytes, or null when the path is absent from HEAD (§7.5). */
  async readBaseline(relPath: string): Promise<Uint8Array | null> {
    if (!this.headExists) return null;
    try {
      // `HEAD:<path>` takes everything after the colon literally, so a path
      // starting with `-` or containing glob characters is safe here.
      const r = await this.git.run(['show', `HEAD:${relPath}`]);
      return r.stdout;
    } catch (err) {
      if (err instanceof GitError && (err.code === 128 || err.code === 1)) return null;
      throw err;
    }
  }

  /** Unified patch for the inline diff view (§7.5.1). */
  async readPatch(relPath: string, status: FileStatusCode): Promise<string> {
    if (status === 'A') {
      const abs = toAbs(this.worktree, relPath);
      try {
        const content = await fs.readFile(abs);
        return makeAddedFilePatch(relPath, content);
      } catch (e) {
        return `# ${relPath}\n# Could not read file: ${describeError(e)}\n`;
      }
    }

    const raw = await this.diffWithContext(relPath, FULL_CONTEXT);
    if (raw.trim().length === 0) {
      return `# ${relPath}\n# No differences against the baseline.\n`;
    }
    // Full context makes the patch as long as the file. That is what makes the
    // view readable — the change is shown in its place rather than as an
    // isolated fragment — but past a point it is just a very long document that
    // renders without highlighting, so a big file falls back to a wide window
    // around each change instead.
    if (countLines(raw) <= MAX_FULL_CONTEXT_LINES) return raw;
    return await this.diffWithContext(relPath, FALLBACK_CONTEXT);
  }

  private diffWithContext(relPath: string, context: number): Promise<string> {
    return this.git.text([
      'diff',
      '--no-color',
      // Belt and braces alongside the `!diff` attribute: neither an external
      // driver nor a textconv may reshape the patch we show the user.
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      `--unified=${context}`,
      'HEAD',
      '--',
      literalPathspec(relPath),
    ]);
  }

  // ------------------------------------------------------------ housekeeping

  async gc(): Promise<void> {
    try {
      await this.git.run(['gc', '--auto', '--quiet'], { timeoutMs: 300_000 });
    } catch (err) {
      // Never let housekeeping take the extension down with it.
      this.log.warn(`git gc failed: ${describeError(err)}`);
    }
  }

  /** Discards all history and takes a fresh snapshot (`lfct.rebuildBaseline`). */
  async rebuild(
    relPaths: string[],
    progress?: ProgressLike,
    token?: CancellationLike,
  ): Promise<void> {
    // Emptying the index rather than deleting the repo keeps existing objects
    // around, so a rebuild is cheap and old content stays recoverable by hand.
    await this.git.run(['read-tree', '--empty']);
    this.headExists = false;
    await this.createInitialBaseline(relPaths, progress, token);
  }

  dispose(): void {
    this.git.dispose();
  }
}

/**
 * `git diff --name-status -z` emits `STATUS\0path\0STATUS\0path\0...`. Renames
 * are disabled (`--no-renames`), so a status is always a single letter and each
 * record is exactly two fields.
 */
export function parseNameStatusZ(raw: string): FileStatus[] {
  const fields = raw.split('\0');
  const out: FileStatus[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const code = fields[i];
    const relPath = fields[i + 1];
    if (!code || !relPath) continue;
    const letter = code[0];
    if (letter === 'M' || letter === 'A' || letter === 'D') {
      out.push({ relPath, status: letter });
    } else if (letter === 'T' || letter === 'C') {
      // Type change (file <-> symlink) and copy both mean "content differs
      // from baseline", which is all the UI needs to know.
      out.push({ relPath, status: 'M' });
    }
  }
  return out;
}

function countLines(text: string): number {
  let n = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) n++;
  }
  return n;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
