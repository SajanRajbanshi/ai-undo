import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Logger } from '../log';
import { nullLogger } from '../log';
import { toPosix } from '../util/paths';
import type { GitMarkerSource } from './ChangeDetector';

/**
 * §6.8 — detects work-tree changes caused by the user's *real* git repository.
 *
 * `git pull`, `merge`, `rebase`, `reset`, `checkout` and `stash` all rewrite
 * files from an external process, so under the §6.2 signal alone they are
 * indistinguishable from an agent. A pull touching 200 files would fill the
 * pending list — and Reject All would then undo the pull.
 *
 * The principle: this tool exists for changes that have no other safety net.
 * Git operations have the reflog, ORIG_HEAD and the stash. Agent writes have
 * nothing. So git-originated writes are auto-accepted by default.
 */

/**
 * Files whose modification means a ref moved. Deliberately excludes `index`,
 * which changes on every `git add` and even on `git status` — including the
 * ones a shell prompt runs constantly.
 */
const MARKER_FILES = new Set([
  'HEAD',
  'ORIG_HEAD',
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'BISECT_HEAD',
  'REBASE_HEAD',
  'packed-refs',
]);

/** Directories whose appearance means an interactive operation started. */
const MARKER_DIR_PREFIXES = ['rebase-merge', 'rebase-apply', 'sequencer'];

/** Timestamps older than this can never be relevant to a burst. */
const MARKER_RETENTION_MS = 120_000;
const MAX_MARKERS = 256;

/**
 * `fs.watch`'s `recursive` option is documented as macOS and Windows only.
 * Checking the platform rather than catching the failure is deliberate: some
 * Node versions accept the flag and then quietly do not recurse, which would
 * leave us believing we had coverage we do not have.
 */
const RECURSIVE_WATCH_SUPPORTED = os.platform() === 'darwin' || os.platform() === 'win32';

/**
 * Bounds for the per-directory fallback. A branch name is a path, so
 * `refs/heads` can nest arbitrarily (`team/feature/thing`), and a repository
 * with hundreds of `user/*` prefixes would otherwise open hundreds of watchers.
 */
const MAX_REF_DIR_DEPTH = 4;
const MAX_REF_DIR_WATCHERS = 64;

export interface GitMarkerRecord {
  at: number;
  source: string;
}

/**
 * The pure half: a ring of "a ref moved at time T" observations, and the
 * window query the detector asks at burst-settle time. No `vscode`, no `fs`,
 * so §13.1 can drive the ±window boundaries directly.
 */
export class GitMarkerTracker implements GitMarkerSource {
  private records: GitMarkerRecord[] = [];
  private isActive = false;

  constructor(private readonly log: Logger = nullLogger) {}

  get active(): boolean {
    return this.isActive;
  }

  setActive(active: boolean): void {
    this.isActive = active;
  }

  record(source: string, at: number = Date.now()): void {
    this.records.push({ at, source });
    if (this.records.length > MAX_MARKERS) {
      this.records = this.records.slice(-MAX_MARKERS);
    }
    this.log.debug(`Git marker moved: ${source} at ${at}`);
  }

  movedWithin(fromMs: number, toMs: number): boolean {
    this.prune(toMs);
    return this.records.some((r) => r.at >= fromMs && r.at <= toMs);
  }

  /** Diagnostics only. */
  recordsWithin(fromMs: number, toMs: number): GitMarkerRecord[] {
    return this.records.filter((r) => r.at >= fromMs && r.at <= toMs);
  }

  private prune(now: number): void {
    const cutoff = now - MARKER_RETENTION_MS;
    if (this.records.length > 0 && this.records[0].at < cutoff) {
      this.records = this.records.filter((r) => r.at >= cutoff);
    }
  }

  clear(): void {
    this.records = [];
  }
}

export interface GitOpMonitorOptions {
  worktree: string;
  log?: Logger;
}

/**
 * The I/O half. Watches the real `.git` directory directly with Node's
 * `fs.watch` rather than VS Code's `FileSystemWatcher`, because the latter
 * honors `files.watcherExclude` whose defaults already touch `.git`.
 *
 * The built-in Git extension's API is a second, independent source; wiring it
 * up is the caller's job (see `attachVscodeGitApi`) so this class stays free of
 * a `vscode` import and remains integration-testable.
 */
export class GitOpMonitor {
  readonly tracker: GitMarkerTracker;
  private watchers: fs.FSWatcher[] = [];
  /** Ref directories already subscribed, so a new branch cannot double-watch one. */
  private readonly watchedRefDirs = new Set<string>();
  private gitDir: string | undefined;
  private readonly log: Logger;

  constructor(private readonly options: GitOpMonitorOptions) {
    this.log = options.log ?? nullLogger;
    this.tracker = new GitMarkerTracker(this.log);
  }

  /** Resolves the real git directory and starts watching. Inert if not a repo. */
  async start(): Promise<void> {
    const gitDir = await resolveGitDir(this.options.worktree);
    if (!gitDir) {
      this.log.info('Workspace is not a git repository; git-operation detection is inert.');
      this.tracker.setActive(false);
      return;
    }
    this.gitDir = gitDir;
    this.tracker.setActive(true);
    this.log.info(`Watching git markers in ${gitDir}`);

    this.watchDir(gitDir, (filename) => {
      if (MARKER_FILES.has(filename)) return `.git/${filename}`;
      if (MARKER_DIR_PREFIXES.some((p) => filename === p || filename.startsWith(p + path.sep))) {
        return `.git/${filename}`;
      }
      return undefined;
    });

    // `git stash push` never moves HEAD, so the Git extension's API cannot see
    // it. refs/stash is what gives it away.
    this.watchDir(path.join(gitDir, 'refs'), (filename) =>
      filename === 'stash' ? '.git/refs/stash' : undefined,
    );

    // A fast-forward `git pull` updates refs/heads/<branch>, not HEAD.
    await this.watchRefsHeads(path.join(gitDir, 'refs', 'heads'));
  }

  /**
   * A branch name is a path: `feature/login` lives at
   * `refs/heads/feature/login`, one directory below the one a plain watch
   * covers. Watching `refs/heads` non-recursively therefore saw `main` move and
   * was blind to every slash-containing branch — so a `git pull` on one of
   * those looked exactly like an agent burst and filled the pending list.
   *
   * One recursive watch settles it where the platform supports that. Everywhere
   * else, each subdirectory gets its own watcher, and a directory appearing
   * later is adopted from its parent's own event.
   */
  private async watchRefsHeads(headsDir: string): Promise<void> {
    if (RECURSIVE_WATCH_SUPPORTED && this.watchRefDir(headsDir, 0, true)) return;

    this.watchRefDir(headsDir, 0, false);
    await this.watchRefSubdirs(headsDir, 0);
  }

  private async watchRefSubdirs(dir: string, depth: number): Promise<void> {
    if (depth >= MAX_REF_DIR_DEPTH) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sub = path.join(dir, entry.name);
      if (this.watchRefDir(sub, depth + 1, false)) {
        await this.watchRefSubdirs(sub, depth + 1);
      }
    }
  }

  /** A `feature/` directory created after startup; subscribe before its first ref lands. */
  private async adoptRefSubdir(abs: string, depth: number): Promise<void> {
    if (depth >= MAX_REF_DIR_DEPTH || this.watchedRefDirs.has(abs)) return;
    try {
      if (!(await fsp.stat(abs)).isDirectory()) return;
    } catch {
      return; // A ref file, or already gone.
    }
    if (this.watchRefDir(abs, depth, false)) {
      await this.watchRefSubdirs(abs, depth);
    }
  }

  private watchRefDir(dir: string, depth: number, recursive: boolean): boolean {
    if (this.watchedRefDirs.has(dir)) return true;
    if (this.watchedRefDirs.size >= MAX_REF_DIR_WATCHERS) {
      this.log.debug(`Not watching ${dir}: already at ${MAX_REF_DIR_WATCHERS} ref watchers.`);
      return false;
    }
    try {
      const watcher = fs.watch(dir, { persistent: false, recursive }, (_event, filename) => {
        if (!filename) return;
        const name = String(filename);
        if (name.endsWith('.lock')) return;
        const abs = path.join(dir, name);
        this.tracker.record(`.git/${toPosix(path.relative(this.gitDir ?? dir, abs))}`);
        // Only the per-directory mode has to grow; a recursive watch already
        // covers whatever appears underneath it.
        if (!recursive) void this.adoptRefSubdir(abs, depth + 1);
      });
      watcher.on('error', (err) => {
        this.log.debug(`git marker watcher error on ${dir}: ${String(err)}`);
      });
      this.watchers.push(watcher);
      this.watchedRefDirs.add(dir);
      return true;
    } catch (err) {
      this.log.debug(
        `Could not watch ${dir}${recursive ? ' recursively' : ''}: ${String(err)}`,
      );
      return false;
    }
  }

  private watchDir(dir: string, classify: (filename: string) => string | undefined): void {
    try {
      const watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
        if (!filename) return;
        const name = String(filename);
        // Ignore git's own lock files: they appear and vanish for every
        // command, including read-only ones.
        if (name.endsWith('.lock')) return;
        const source = classify(name);
        if (source) this.tracker.record(source);
      });
      watcher.on('error', (err) => {
        this.log.debug(`git marker watcher error on ${dir}: ${String(err)}`);
      });
      this.watchers.push(watcher);
    } catch (err) {
      // A missing refs/heads on a fresh repo is normal, not an error.
      this.log.debug(`Could not watch ${dir}: ${String(err)}`);
    }
  }

  /**
   * Records a marker move observed by the built-in Git extension. The caller
   * must only invoke this when `HEAD.commit`, `HEAD.name` or `rebaseCommit`
   * actually changed — `Repository.state.onDidChange` also fires on ordinary
   * work-tree changes, and treating those as git operations would auto-accept
   * every agent burst.
   */
  recordFromGitApi(detail: string): void {
    this.tracker.setActive(true);
    this.tracker.record(`vscode.git:${detail}`);
  }

  get resolvedGitDir(): string | undefined {
    return this.gitDir;
  }

  dispose(): void {
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        /* already closed */
      }
    }
    this.watchers = [];
    this.watchedRefDirs.clear();
  }
}

/**
 * `.git` is normally a directory, but is a file containing `gitdir: <path>`
 * inside a linked worktree or a submodule.
 */
export async function resolveGitDir(worktree: string): Promise<string | undefined> {
  const dotGit = path.join(worktree, '.git');
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(dotGit);
  } catch {
    return undefined;
  }
  if (stat.isDirectory()) return dotGit;
  if (!stat.isFile()) return undefined;

  try {
    const content = await fsp.readFile(dotGit, 'utf8');
    const match = /^gitdir:\s*(.+)$/m.exec(content);
    if (!match) return undefined;
    const target = match[1].trim();
    const resolved = path.isAbsolute(target) ? target : path.resolve(worktree, target);
    const targetStat = await fsp.stat(resolved);
    return targetStat.isDirectory() ? resolved : undefined;
  } catch {
    return undefined;
  }
}
