import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { Logger } from '../log';
import { nullLogger } from '../log';
import type { BaselineEntry, CheckpointStore, FileStatus } from '../store/CheckpointStore';
import { writeJsonAtomic } from '../store/init';
import { toAbs } from '../util/paths';

/**
 * §6.8 — auto-accepting git operations without letting a round trip erase
 * review state.
 *
 * `git stash` takes pending agent changes off disk and `git stash pop` puts
 * them back. Both are git operations, so both used to be auto-accepted: the
 * first accepted HEAD's content, the second accepted the agent's content — and
 * changes nobody had reviewed were accepted by a command that only ever set
 * them aside. The baseline is a single rolling pointer with no memory of where
 * it was, so nothing could list them again.
 *
 * The fix is to remember, per path, what the auto-accept replaced: the content
 * that was pending, and the baseline it was pending against. When a later write
 * puts back exactly that content, the baseline goes back too, and the file is
 * listed as it was before the stash.
 *
 * Matching on content rather than on stash refs is deliberate. It covers `pop`,
 * `apply` (which moves no marker at all, so it arrives as an agent burst), the
 * Source Control view's stash commands and `stash -u`, and it cannot misfire
 * on an unrelated operation: restoring requires the bytes on disk to be the very
 * bytes that were pending review.
 */

/** One path's review state, set aside when a git operation took its pending content off disk. */
export interface ParkedReview {
  /** Object id of the content that was pending review; `null` for a pending deletion. */
  pending: string | null;
  /** The baseline that content was pending against; `null` when the path was not in it. */
  restore: BaselineEntry | null;
  /**
   * The baseline the auto-accept left behind. Once the baseline has moved on
   * from this, the file has been accepted or edited since and the entry is void.
   */
  accepted: string | null;
}

/** The state of a burst's paths at the moment it is handled. */
export interface WriteSnapshot {
  paths: readonly string[];
  /** Work-tree object ids: `null` for a missing file, absent when it could not be hashed. */
  disk: ReadonlyMap<string, string | null>;
  /** Current baseline entries; absent when a path is not in the baseline. */
  baseline: ReadonlyMap<string, BaselineEntry>;
}

export interface BaselineRestore {
  relPath: string;
  entry: BaselineEntry | null;
}

export interface GitOperationPlan {
  /** Parked reviews whose content just came back: their baseline goes back too. */
  restore: BaselineRestore[];
  /** Everything else is auto-accepted, as before. */
  accept: string[];
  /** Pending content this operation is taking off disk. */
  park: { relPath: string; pending: string | null; restore: BaselineEntry | null }[];
  /** Parked entries this operation voids by accepting different content over them. */
  drop: string[];
}

/** Paths whose parked content is back on disk, over the baseline the auto-accept left. */
export function findReturningReviews(
  snapshot: WriteSnapshot,
  parked: ReadonlyMap<string, ParkedReview>,
): BaselineRestore[] {
  const out: BaselineRestore[] = [];
  for (const relPath of snapshot.paths) {
    const entry = parked.get(relPath);
    if (!entry) continue;
    const onDisk = snapshot.disk.get(relPath);
    if (onDisk === undefined || onDisk !== entry.pending) continue;
    if ((snapshot.baseline.get(relPath)?.oid ?? null) !== entry.accepted) continue;
    out.push({ relPath, entry: entry.restore });
  }
  return out;
}

/**
 * The pure half of `ReviewParking.acceptGitOperation`. `observed` holds the
 * last content id seen pending per path.
 */
export function planGitOperation(
  snapshot: WriteSnapshot,
  observed: ReadonlyMap<string, { oid: string | null }>,
  parked: ReadonlyMap<string, ParkedReview>,
): GitOperationPlan {
  const restore = findReturningReviews(snapshot, parked);
  const restoring = new Set(restore.map((r) => r.relPath));
  const plan: GitOperationPlan = { restore, accept: [], park: [], drop: [] };

  for (const relPath of snapshot.paths) {
    if (restoring.has(relPath)) continue;
    plan.accept.push(relPath);

    const onDisk = snapshot.disk.get(relPath);
    if (onDisk === undefined) continue;
    const base = snapshot.baseline.get(relPath) ?? null;
    const seen = observed.get(relPath);

    // Park only content that was really pending: it differs from the baseline
    // (so it was not accepted since it was seen) and from what is on disk now
    // (so this operation is what took it away).
    if (seen !== undefined && seen.oid !== onDisk && seen.oid !== (base?.oid ?? null)) {
      plan.park.push({ relPath, pending: seen.oid, restore: base });
    } else if (parked.has(relPath) && parked.get(relPath)!.accepted !== onDisk) {
      plan.drop.push(relPath);
    }
  }
  return plan;
}

export const PARKED_FILE_NAME = 'parked.json';
const PARKED_SCHEMA_VERSION = 1;

interface Observation {
  oid: string | null;
  size: number;
  mtimeMs: number;
}

/**
 * The I/O half: observes pending content after each sweep, and performs the
 * git-operation accept. Parked entries are persisted, because a stash and its
 * pop can be a window reload apart.
 */
export class ReviewParking {
  /**
   * The last content id seen pending for each path. A sweep does not remove an
   * entry when its path stops being pending: the sweep that notices a stash can
   * finish before the burst reporting it settles, and forgetting here would
   * lose exactly the observation that burst needs. An entry is consumed when
   * it is parked instead.
   */
  private readonly observed = new Map<string, Observation>();
  private readonly parked = new Map<string, ParkedReview>();
  /** Serializes every operation, so a burst always plans against the latest observation. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: CheckpointStore,
    private readonly storagePath: string,
    private readonly log: Logger = nullLogger,
  ) {}

  private get filePath(): string {
    return path.join(this.storagePath, PARKED_FILE_NAME);
  }

  /** Diagnostics and tests. */
  get parkedPaths(): string[] {
    return [...this.parked.keys()];
  }

  async load(): Promise<void> {
    let raw: { schemaVersion?: unknown; entries?: unknown };
    try {
      raw = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
    } catch {
      return; // Nothing parked yet, or unreadable: either way nothing to restore.
    }
    if (raw?.schemaVersion !== PARKED_SCHEMA_VERSION || typeof raw.entries !== 'object') return;
    for (const [relPath, value] of Object.entries(raw.entries ?? {})) {
      if (isParkedReview(value)) this.parked.set(relPath, value);
    }
    if (this.parked.size > 0) {
      this.log.info(`Loaded parked review state for ${this.parked.size} path(s).`);
    }
  }

  /** Called after every sweep. Only pending files whose size or mtime moved are rehashed. */
  observe(statuses: readonly FileStatus[]): Promise<void> {
    return this.exclusive(() => this.observeNow(statuses)).catch((err) => {
      this.log.debug(`Observing pending content failed: ${String(err)}`);
    });
  }

  /**
   * Auto-accepts a git operation's paths, except those whose parked review
   * just came back, which get their old baseline instead.
   */
  acceptGitOperation(
    relPaths: readonly string[],
    reason: string,
  ): Promise<{ accepted: string[]; restored: string[] }> {
    return this.exclusive(async () => {
      // A pull over files nobody had pending must cost what it always did.
      if (!relPaths.some((rel) => this.observed.has(rel) || this.parked.has(rel))) {
        await this.store.commitPaths([...relPaths], reason);
        return { accepted: [...relPaths], restored: [] };
      }

      const plan = planGitOperation(await this.snapshot(relPaths), this.observed, this.parked);
      await this.store.setBaselineEntries(plan.restore, 'restore review state after a git operation');
      await this.store.commitPaths(plan.accept, reason);

      for (const { relPath } of plan.restore) this.parked.delete(relPath);
      for (const relPath of plan.drop) this.parked.delete(relPath);
      if (plan.park.length > 0) {
        const after = await this.store.baselineEntries(plan.park.map((p) => p.relPath));
        for (const p of plan.park) {
          this.parked.set(p.relPath, {
            pending: p.pending,
            restore: p.restore,
            accepted: after.get(p.relPath)?.oid ?? null,
          });
          this.observed.delete(p.relPath);
        }
        this.log.info(`Parked review state for ${plan.park.length} path(s) a git operation took off disk.`);
      }
      if (plan.restore.length + plan.drop.length + plan.park.length > 0) await this.save();

      return { accepted: plan.accept, restored: plan.restore.map((r) => r.relPath) };
    });
  }

  /**
   * For writes that are not being accepted — an agent burst, or a git
   * operation under `surface`/`prompt` — only the restoring half applies.
   */
  restoreReturning(relPaths: readonly string[]): Promise<string[]> {
    return this.exclusive(async () => {
      const candidates = relPaths.filter((rel) => this.parked.has(rel));
      if (candidates.length === 0) return [];

      const restore = findReturningReviews(await this.snapshot(candidates), this.parked);
      if (restore.length === 0) return [];
      await this.store.setBaselineEntries(restore, 'restore review state');
      for (const { relPath } of restore) this.parked.delete(relPath);
      await this.save();
      return restore.map((r) => r.relPath);
    });
  }

  /** A rebuilt baseline starts over, parked reviews included. */
  clear(): Promise<void> {
    return this.exclusive(async () => {
      this.observed.clear();
      this.parked.clear();
      await this.save();
    });
  }

  private async observeNow(statuses: readonly FileStatus[]): Promise<void> {
    const changed = new Map<string, { size: number; mtimeMs: number }>();
    await Promise.all(
      statuses.map(async ({ relPath, status }) => {
        if (status === 'D') {
          this.observed.set(relPath, { oid: null, size: -1, mtimeMs: -1 });
          return;
        }
        try {
          const st = await fs.lstat(toAbs(this.store.worktree, relPath));
          const prev = this.observed.get(relPath);
          if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) return;
          changed.set(relPath, { size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          /* gone since the sweep; the next one will say so */
        }
      }),
    );
    if (changed.size === 0) return;

    const ids = await this.store.hashWorktreeFiles([...changed.keys()]);
    for (const [relPath, stat] of changed) {
      const oid = ids.get(relPath);
      if (oid) this.observed.set(relPath, { oid, ...stat });
    }
  }

  private async snapshot(relPaths: readonly string[]): Promise<WriteSnapshot> {
    const disk = await this.store.hashWorktreeFiles(relPaths);
    const baseline = await this.store.baselineEntries(relPaths);
    return { paths: relPaths, disk, baseline };
  }

  private async save(): Promise<void> {
    if (this.parked.size === 0) {
      await fs.rm(this.filePath, { force: true });
      return;
    }
    await writeJsonAtomic(this.filePath, {
      schemaVersion: PARKED_SCHEMA_VERSION,
      entries: Object.fromEntries(this.parked),
    });
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.queue.then(fn, fn);
    this.queue = task.catch(() => undefined);
    return task;
  }
}

function isParkedReview(value: unknown): value is ParkedReview {
  const v = value as ParkedReview;
  const oidOrNull = (x: unknown) => x === null || typeof x === 'string';
  const entryOrNull = (x: unknown) =>
    x === null ||
    (typeof x === 'object' &&
      typeof (x as BaselineEntry).mode === 'string' &&
      typeof (x as BaselineEntry).oid === 'string');
  return (
    typeof v === 'object' &&
    v !== null &&
    oidOrNull(v.pending) &&
    oidOrNull(v.accepted) &&
    entryOrNull(v.restore)
  );
}
