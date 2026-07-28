import type { LfctConfig } from '../config';
import type { Logger } from '../log';
import { nullLogger } from '../log';
import { Emitter, type Event } from '../util/emitter';
import { pathKey } from '../util/paths';

/**
 * §6 / §7.3 — forensic attribution after the fact.
 *
 * Cursor, Windsurf and Kilo Code never have to solve this: they *are* the
 * writer, so authorship is known with perfect fidelity at write time. We are
 * reconstructing it for agents we do not control, which is strictly harder and
 * is also exactly what makes this work across every agent instead of one.
 *
 * This module has no `vscode` import on purpose. The whole state machine is
 * driven by injected time and timers so §13.1 can exercise event sequences,
 * expiry boundaries and the git-correlation window deterministically.
 */

export type FsEventKind = 'create' | 'change' | 'delete';

export interface FsEvent {
  absPath: string;
  kind: FsEventKind;
  /** True when the event target is a directory. Forces a sweep (§6.9). */
  isDirectory?: boolean;
}

export type BurstOrigin = 'agent' | 'git';

export interface BurstSettledEvent {
  paths: string[];
  origin: BurstOrigin;
  startedAt: number;
  endedAt: number;
}

/** Answers "did the user's real repository move a ref inside this window?" (§6.8) */
export interface GitMarkerSource {
  movedWithin(fromMs: number, toMs: number): boolean;
  /** False when the workspace is not a git repository; the subsystem is then inert. */
  readonly active: boolean;
}

export interface DetectorClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: DetectorClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface ChangeDetectorOptions {
  config: LfctConfig;
  isTracked(absPath: string): boolean;
  gitMarkers: GitMarkerSource;
  clock?: DetectorClock;
  log?: Logger;
}

/**
 * How long a suppression entry survives (§6.6). Deliberately *not* cleared on
 * first match: one `git checkout` can produce several watcher events for one
 * path, and re-listing a file we just restored is a far worse failure than
 * missing an agent write to that same path within two seconds.
 */
const SUPPRESSION_TTL_MS = 2000;

/** P4 — coalesce saves within this window into a single commit. */
const USER_EDIT_DEBOUNCE_MS = 500;

export class ChangeDetector {
  /** §6.3 — absolute path key to the timestamp the editor told us about it. */
  private readonly expectedWrites = new Map<string, number>();
  /** §6.6 — paths we are about to write ourselves. */
  private readonly suppressed = new Map<string, number>();
  /** Paths in the burst currently accumulating. Keyed for the FS, valued raw. */
  private readonly pending = new Map<string, string>();
  /** User edits waiting to be batched into one silent baseline advance. */
  private readonly userEdits = new Map<string, string>();

  private burstStartedAt = 0;
  private burstLastEventAt = 0;
  /** Throttles the suppression sweep; see `expireExpectedWrites`. */
  private lastSuppressionSweepAt = 0;
  private burstTimer: unknown;
  private userEditTimer: unknown;
  private started = false;
  private disposed = false;

  private readonly clock: DetectorClock;
  private readonly log: Logger;
  private config: LfctConfig;
  private readonly isTracked: (absPath: string) => boolean;
  private readonly gitMarkers: GitMarkerSource;

  private readonly burstSettledEmitter = new Emitter<BurstSettledEvent>();
  private readonly userEditEmitter = new Emitter<string[]>();
  private readonly sweepEmitter = new Emitter<{ reason: string }>();

  /** Fires once a burst of external writes has settled and been classified. */
  readonly onBurstSettled: Event<BurstSettledEvent> = this.burstSettledEmitter.event;
  /** Fires with paths the user edited, batched. The baseline advances silently. */
  readonly onUserEdit: Event<string[]> = this.userEditEmitter.event;
  /** Fires when something happened that only a full reconciliation can resolve. */
  readonly onSweepRequested: Event<{ reason: string }> = this.sweepEmitter.event;

  constructor(options: ChangeDetectorOptions) {
    this.config = options.config;
    this.isTracked = options.isTracked;
    this.gitMarkers = options.gitMarkers;
    this.clock = options.clock ?? realClock;
    this.log = options.log ?? nullLogger;
  }

  start(): void {
    this.started = true;
  }

  updateConfig(config: LfctConfig): void {
    this.config = config;
  }

  // ------------------------------------------------------- editor-side input

  /**
   * §6.3 — populated from `onDidSaveTextDocument`, `onDidCreateFiles`,
   * `onDidDeleteFiles` and `onDidRenameFiles`. Those fire before or around the
   * disk write, which is precisely the ordering that makes attribution
   * possible. `onWillSaveTextDocument` is deliberately unused: it can delay the
   * save and we need no veto.
   */
  noteExpectedWrite(absPath: string): void {
    this.expectedWrites.set(pathKey(absPath), this.clock.now());
  }

  noteExpectedWrites(absPaths: readonly string[]): void {
    for (const p of absPaths) this.noteExpectedWrite(p);
  }

  /**
   * §6.6 — must be called *before* our own write begins. Without pre-arming,
   * the extension classifies its own restore as a fresh external write and
   * immediately re-lists the file it just restored.
   */
  suppressPath(absPath: string): void {
    this.suppressed.set(pathKey(absPath), this.clock.now());
  }

  suppressPaths(absPaths: readonly string[]): void {
    for (const p of absPaths) this.suppressPath(p);
  }

  // --------------------------------------------------------- watcher input

  handleFsEvent(event: FsEvent): void {
    if (!this.started || this.disposed) return;

    const key = pathKey(event.absPath);
    const now = this.clock.now();

    // Suppression is checked before the denylist so that our own writes are
    // cheap to discard, and before expiry so a stale entry cannot leak.
    const suppressedAt = this.suppressed.get(key);
    if (suppressedAt !== undefined) {
      if (now - suppressedAt <= SUPPRESSION_TTL_MS) {
        this.log.debug(`Suppressed self-write: ${event.absPath}`);
        return;
      }
      this.suppressed.delete(key);
    }

    // §6.9 / E10c — macOS FSEvents may coalesce a directory rename into one
    // event for the directory itself, so 200 contained files would surface as
    // almost nothing. Never trust per-file events to arrive; force a sweep.
    if (event.isDirectory && (event.kind === 'create' || event.kind === 'delete')) {
      this.log.info(`Directory ${event.kind} at ${event.absPath}; forcing reconciliation.`);
      this.sweepEmitter.fire({ reason: `directory-${event.kind}` });
      return;
    }

    if (!this.isTracked(event.absPath)) return;

    this.expireExpectedWrites(now);

    const expectedAt = this.expectedWrites.get(key);
    if (expectedAt !== undefined && now - expectedAt <= this.config.userEditGraceMs) {
      // §6.4 — the editor told us this was coming. Advance the baseline
      // silently; nothing surfaces, no badge, no toast. This is the behavior
      // that keeps the pending list meaningful.
      this.expectedWrites.delete(key);
      this.queueUserEdit(event.absPath);
      return;
    }

    this.addToBurst(event.absPath, now);
  }

  private addToBurst(absPath: string, now: number): void {
    if (this.pending.size === 0) this.burstStartedAt = now;
    this.burstLastEventAt = now;
    this.pending.set(pathKey(absPath), absPath);

    if (this.burstTimer !== undefined) this.clock.clearTimeout(this.burstTimer);
    this.burstTimer = this.clock.setTimeout(() => this.settleBurst(), this.config.burstQuietMs);
  }

  /**
   * §6.8 — classification happens here, not per event, because git writes
   * work-tree files *before* it updates HEAD. At settle time we can finally ask
   * whether a marker moved.
   */
  private settleBurst(): void {
    this.burstTimer = undefined;
    if (this.pending.size === 0) return;

    const paths = [...this.pending.values()];
    this.pending.clear();

    const now = this.clock.now();
    const from = this.burstStartedAt - this.config.gitOpWindowMs;
    // `now` is already burstQuietMs past the last write, which covers the
    // normal case where git updates HEAD immediately after the work tree. A
    // marker that moves later still falls through to 'agent' — E10b, harmless,
    // since Accept All resolves it.
    const origin: BurstOrigin =
      this.gitMarkers.active && this.gitMarkers.movedWithin(from, now) ? 'git' : 'agent';

    this.log.info(
      `Burst settled: ${paths.length} path(s), origin=${origin} ` +
        `(window ${from}..${now}, started ${this.burstStartedAt})`,
    );

    this.burstSettledEmitter.fire({
      paths,
      origin,
      startedAt: this.burstStartedAt,
      endedAt: this.burstLastEventAt,
    });
  }

  private queueUserEdit(absPath: string): void {
    this.userEdits.set(pathKey(absPath), absPath);
    if (this.userEditTimer !== undefined) this.clock.clearTimeout(this.userEditTimer);
    this.userEditTimer = this.clock.setTimeout(() => {
      this.userEditTimer = undefined;
      const paths = [...this.userEdits.values()];
      this.userEdits.clear();
      if (paths.length > 0) {
        this.log.debug(`User edit batch: ${paths.length} path(s)`);
        this.userEditEmitter.fire(paths);
      }
    }, USER_EDIT_DEBOUNCE_MS);
  }

  /**
   * §6.3 — without expiry, a save whose watcher event never arrived leaves a
   * permanent entry that would misclassify a later agent write to that same
   * path as a user edit.
   *
   * Both maps are swept, each behind its own guard. Putting the suppression
   * sweep behind `expectedWrites.size === 0` used to make it unreachable in the
   * common case: a Reject All arms hundreds of suppression entries, and each
   * then survived until that exact path happened to see another watcher event.
   * Behaviour stayed correct — every read is TTL-checked — but the map grew for
   * the life of the window.
   *
   * P2 governs the shape of the fix. This runs on every tracked filesystem
   * event, so the suppression sweep is throttled to once per TTL rather than
   * run per event: entries only live `SUPPRESSION_TTL_MS` anyway, so a sweep
   * any more often than that can have nothing to do.
   */
  private expireExpectedWrites(now: number): void {
    if (this.expectedWrites.size > 0) {
      const grace = this.config.userEditGraceMs;
      for (const [key, at] of this.expectedWrites) {
        if (now - at > grace) this.expectedWrites.delete(key);
      }
    }

    if (this.suppressed.size > 0 && now - this.lastSuppressionSweepAt >= SUPPRESSION_TTL_MS) {
      this.lastSuppressionSweepAt = now;
      for (const [key, at] of this.suppressed) {
        if (now - at > SUPPRESSION_TTL_MS) this.suppressed.delete(key);
      }
    }
  }

  /** Requests a reconciliation sweep from outside (focus regained, timer, command). */
  requestSweep(reason: string): void {
    this.sweepEmitter.fire({ reason });
  }

  /**
   * Drops a path from the burst that is currently accumulating. Used when a
   * reject lands while a burst is still open, so the restored file does not
   * reappear the moment the burst settles.
   */
  forgetPending(absPath: string): void {
    this.pending.delete(pathKey(absPath));
  }

  /** Test and diagnostic surface. */
  get state(): {
    pending: number;
    expectedWrites: number;
    suppressed: number;
    burstOpen: boolean;
  } {
    return {
      pending: this.pending.size,
      expectedWrites: this.expectedWrites.size,
      suppressed: this.suppressed.size,
      burstOpen: this.burstTimer !== undefined,
    };
  }

  dispose(): void {
    this.disposed = true;
    if (this.burstTimer !== undefined) this.clock.clearTimeout(this.burstTimer);
    if (this.userEditTimer !== undefined) this.clock.clearTimeout(this.userEditTimer);
    this.burstSettledEmitter.dispose();
    this.userEditEmitter.dispose();
    this.sweepEmitter.dispose();
    this.pending.clear();
    this.expectedWrites.clear();
    this.suppressed.clear();
    this.userEdits.clear();
  }
}
