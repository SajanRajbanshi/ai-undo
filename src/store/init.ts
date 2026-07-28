import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Logger } from '../log';
import { FSMONITOR_VERSION, Git, versionAtLeast, type GitVersion } from './git';

/**
 * §5.4 — shadow repository initialization. Every setting here exists to keep
 * the user's environment from leaking into a store whose whole job is to
 * reproduce bytes exactly.
 */

/** Bump only for a genuinely incompatible on-disk change (E21). */
export const SCHEMA_VERSION = 1;

export interface StoreMeta {
  version: string;
  schemaVersion: number;
  worktreePath: string;
  createdAt: string;
  lastAcceptAt: string | null;
}

export const SHADOW_DIR_NAME = 'shadow.git';
export const META_FILE_NAME = 'meta.json';
const HOOKS_DIR_NAME = 'nohooks';
const STALE_LOCK_MS = 60_000;

/**
 * §5.4.1 — the highest-precedence attributes file in git, above any in-tree
 * `.gitattributes`. `-text` kills CRLF normalization and `-filter` kills
 * clean/smudge including Git LFS, so content passes through byte-for-byte in
 * both directions. Without this, a project using LFS would have its real files
 * replaced by pointer files on restore.
 *
 * `diff` is `!diff` (unspecified), **not** `-diff` as §5.4.1 writes it. In
 * gitattributes, unsetting `diff` means "treat this as binary", which would
 * make `git diff` emit "Binary files ... differ" for every text file in the
 * project and silently destroy the inline unified patch view that G9 requires.
 * `!diff` instead clears any in-tree `diff=lfs`-style driver and hands the
 * decision back to git's own text/binary sniffing, which is exactly what we
 * want. `-merge` is harmless because this repository is never merged.
 */
export const ATTRIBUTES_CONTENT = '* -text !diff -filter -merge\n';

export interface InitResult {
  git: Git;
  meta: StoreMeta;
  /** Set when a stale index.lock was removed on open (E6). */
  recoveredStaleLock: boolean;
}

export class SchemaMismatchError extends Error {
  constructor(
    readonly found: number,
    readonly expected: number,
  ) {
    super(
      `Checkpoint store schema version ${found} does not match this version of the extension (${expected}).`,
    );
    this.name = 'SchemaMismatchError';
  }
}

export class WorktreeMismatchError extends Error {
  constructor(
    readonly recorded: string,
    readonly actual: string,
  ) {
    super(`Checkpoint store belongs to a different workspace (${recorded}, expected ${actual}).`);
    this.name = 'WorktreeMismatchError';
  }
}

export async function initStore(opts: {
  storagePath: string;
  worktree: string;
  version: GitVersion;
  extensionVersion: string;
  fsMonitor: boolean;
  log: Logger;
  gitPath?: string;
}): Promise<InitResult> {
  const { storagePath, worktree, log } = opts;
  const gitDir = path.join(storagePath, SHADOW_DIR_NAME);

  await fs.mkdir(storagePath, { recursive: true });
  await fs.mkdir(path.join(storagePath, HOOKS_DIR_NAME), { recursive: true });

  const meta = await readOrCreateMeta(storagePath, worktree, opts.extensionVersion);

  const git = await Git.create({
    gitDir,
    workTree: worktree,
    version: opts.version,
    storagePath,
    log,
    gitPath: opts.gitPath,
  });

  const alreadyInitialized = await exists(path.join(gitDir, 'HEAD'));
  if (!alreadyInitialized) {
    log.info(`Initializing shadow repository at ${gitDir}`);
    // `init.templateDir=` keeps the user's hook templates out of the store
    // before a single hook file can be copied in.
    await git.run(['-c', 'init.templateDir=', '-c', 'init.defaultBranch=main', 'init', '--quiet']);
  }

  const recoveredStaleLock = await recoverStaleIndexLock(gitDir, log);
  await applyConfig(git, worktree, storagePath, opts.version, opts.fsMonitor, log);
  await writeInfoFiles(gitDir);

  return { git, meta, recoveredStaleLock };
}

async function applyConfig(
  git: Git,
  worktree: string,
  storagePath: string,
  version: GitVersion,
  fsMonitor: boolean,
  log: Logger,
): Promise<void> {
  const settings: [string, string][] = [
    // A GIT_DIR-only init can produce a bare repo on older git. Modern git does
    // the right thing when GIT_WORK_TREE is also set, but assert it anyway.
    ['core.bare', 'false'],
    ['core.worktree', worktree],
    // Not optional (§5.4): without this a project's pre-commit hook runs on
    // every single checkpoint commit. An empty directory rather than /dev/null
    // so the behavior is identical on Windows.
    ['core.hooksPath', path.join(storagePath, HOOKS_DIR_NAME)],
    // A global commit.gpgsign would either prompt or fail every commit.
    ['commit.gpgsign', 'false'],
    ['tag.gpgsign', 'false'],
    // The global identity may be unset entirely; commits would then fail.
    ['user.name', 'AI Undo'],
    ['user.email', 'lfct@localhost'],
    // Byte-exactness (G4). The in-tree .gitattributes neutralization in
    // writeInfoFiles() is what actually guarantees this, but these close the
    // door from the config side too.
    ['core.autocrlf', 'false'],
    ['core.safecrlf', 'false'],
    ['core.fileMode', 'true'],
    ['core.symlinks', 'true'],
    // We never render git's own path quoting; -z output plus this keeps
    // non-ASCII paths intact.
    ['core.quotepath', 'false'],
    ['core.preloadIndex', 'true'],
    ['core.untrackedCache', 'true'],
    // Loose objects accumulate fast at one commit per save; let git pack them.
    ['gc.auto', '256'],
    ['gc.autoDetach', 'true'],
    // We decompose renames ourselves (§6.9); never let git's detection reshape
    // the name-status output we parse.
    ['diff.renames', 'false'],
    ['status.showUntrackedFiles', 'no'],
  ];

  for (const [key, value] of settings) {
    await git.run(['config', key, value]);
  }

  // §5.4 specifies core.fsmonitor, but the built-in monitor spawns a background
  // daemon rooted at the *user's project directory* and is unsupported on
  // Linux. That is a heavier footprint than this extension should take by
  // default, so it is opt-in via `lfct.fsMonitor` and gated on platform and
  // version.
  const platformSupportsFsMonitor = os.platform() === 'darwin' || os.platform() === 'win32';
  const wantFsMonitor =
    fsMonitor && platformSupportsFsMonitor && versionAtLeast(version, FSMONITOR_VERSION);
  await git.run(['config', 'core.fsmonitor', wantFsMonitor ? 'true' : 'false']);
  if (fsMonitor && !wantFsMonitor) {
    log.warn(
      `lfct.fsMonitor is on but unavailable here (platform=${os.platform()}, git=${version.raw}); continuing without it.`,
    );
  }
}

async function writeInfoFiles(gitDir: string): Promise<void> {
  const infoDir = path.join(gitDir, 'info');
  await fs.mkdir(infoDir, { recursive: true });
  // §5.4.1. Highest precedence in git, above any in-tree .gitattributes.
  await fs.writeFile(path.join(infoDir, 'attributes'), ATTRIBUTES_CONTENT, 'utf8');
  // We own file selection entirely (§5.5.1), so exclude rules are inert by
  // construction. Written empty so a stale one from an older store cannot
  // linger and surprise someone reading the store by hand.
  await fs.writeFile(
    path.join(infoDir, 'exclude'),
    '# Intentionally empty: file selection is owned by the extension, not git.\n',
    'utf8',
  );
}

/**
 * E6 — a host that died mid-commit leaves an index.lock that blocks every
 * subsequent operation forever. Anything older than a minute cannot belong to a
 * live process of ours, because every invocation is serialized and none runs
 * that long.
 */
async function recoverStaleIndexLock(gitDir: string, log: Logger): Promise<boolean> {
  const lockPath = path.join(gitDir, 'index.lock');
  try {
    const st = await fs.stat(lockPath);
    const age = Date.now() - st.mtimeMs;
    if (age < STALE_LOCK_MS) {
      log.warn(`index.lock exists and is only ${age}ms old; leaving it alone.`);
      return false;
    }
    await fs.rm(lockPath, { force: true });
    log.warn(`Removed stale index.lock (${Math.round(age / 1000)}s old) at ${lockPath}`);
    return true;
  } catch {
    return false;
  }
}

async function readOrCreateMeta(
  storagePath: string,
  worktree: string,
  extensionVersion: string,
): Promise<StoreMeta> {
  const metaPath = path.join(storagePath, META_FILE_NAME);
  let existing: StoreMeta | undefined;
  try {
    existing = JSON.parse(await fs.readFile(metaPath, 'utf8')) as StoreMeta;
  } catch {
    existing = undefined;
  }

  if (existing) {
    // E21 — refuse rather than guess. Misreading an old store is worse than
    // stopping and asking for a rebuild.
    if (existing.schemaVersion !== SCHEMA_VERSION) {
      throw new SchemaMismatchError(existing.schemaVersion, SCHEMA_VERSION);
    }
    // E4 — this store belongs to a different work tree. Operating on it would
    // restore one project's files into another.
    if (existing.worktreePath && !samePath(existing.worktreePath, worktree)) {
      throw new WorktreeMismatchError(existing.worktreePath, worktree);
    }
    if (existing.version !== extensionVersion) {
      existing.version = extensionVersion;
      await writeMeta(storagePath, existing);
    }
    return existing;
  }

  const meta: StoreMeta = {
    version: extensionVersion,
    schemaVersion: SCHEMA_VERSION,
    worktreePath: worktree,
    createdAt: new Date().toISOString(),
    lastAcceptAt: null,
  };
  await writeMeta(storagePath, meta);
  return meta;
}

/**
 * Write-then-rename, so a crash mid-write can never leave a truncated
 * `meta.json` that fails to parse on the next open.
 *
 * The temp name must be unique per write. Two accepts can reach here at the
 * same moment — a git-operation auto-accept racing a user's Accept, or per-hunk
 * accepts in quick succession — and `commitPaths` calls this *outside* the git
 * queue in `git.ts`, so that queue does not serialize it. With a shared
 * `meta.json.tmp` the interleaving is:
 *
 *   A writes tmp → B writes tmp → A renames tmp away → B renames → ENOENT
 *
 * which surfaces as "Could not accept changes… Nothing on disk was modified"
 * for an accept that in fact succeeded, and leaves a stray temp file behind.
 * Unique names make each writer's rename atomic and independent; last one wins,
 * which is correct because the only field that differs is `lastAcceptAt`.
 */
export async function writeMeta(storagePath: string, meta: StoreMeta): Promise<void> {
  const metaPath = path.join(storagePath, META_FILE_NAME);
  const tmp = `${metaPath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(meta, null, 2), 'utf8');
  try {
    await fs.rename(tmp, metaPath);
  } catch (err) {
    // Never leave the temp file behind; the store directory is the user's.
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, '');
  const na = norm(a);
  const nb = norm(b);
  return os.platform() === 'darwin' || os.platform() === 'win32'
    ? na.toLowerCase() === nb.toLowerCase()
    : na === nb;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
