import type { Logger } from '../log';
import { nullLogger } from '../log';
import type { WorkspaceWalker } from '../scan/WorkspaceWalker';
import type { CancellationLike, CheckpointStore, FileStatus } from '../store/CheckpointStore';

/**
 * §7.3 — the reconciliation sweep.
 *
 * The watcher is a latency optimization, not the source of truth. It honors the
 * user's `files.watcherExclude`, drops events under load, and receives nothing
 * at all while the window is closed (S15/E9). Correctness rests entirely on
 * this comparison of a complete walk against a complete index (§5.5.1), which
 * is also what makes a coalesced folder rename resolve to N deletes plus N adds
 * regardless of what the watcher reported (§6.9).
 */

export interface ReconcileResult {
  statuses: FileStatus[];
  /**
   * Every eligible path found on disk. Returned rather than recomputed because
   * the caller needs it to classify directory-delete events, and walking twice
   * would double the cost of the most frequent operation in the extension.
   */
  onDisk: string[];
  /** Paths present in the baseline. Drives quick-diff eligibility. */
  tracked: Set<string>;
  durationMs: number;
  cancelled: boolean;
}

export async function reconcile(
  store: CheckpointStore,
  walker: WorkspaceWalker,
  log: Logger = nullLogger,
  token?: CancellationLike,
): Promise<ReconcileResult> {
  const started = Date.now();
  const onDisk = await walker.walk(token);

  if (token?.isCancellationRequested) {
    return {
      statuses: [],
      onDisk,
      tracked: new Set(),
      durationMs: Date.now() - started,
      cancelled: true,
    };
  }

  const { statuses, tracked } = await store.statusWithTracked(onDisk);
  const durationMs = Date.now() - started;

  log.debug(
    `Reconcile: ${onDisk.length} files on disk, ${statuses.length} diverging from baseline, ${durationMs}ms`,
  );

  return { statuses, onDisk, tracked, durationMs, cancelled: false };
}

/**
 * Coalesces sweep requests. Several triggers can fire at once — a directory
 * event, a burst settling, and the periodic timer — and each sweep walks the
 * whole tree, so overlapping runs would be pure waste.
 */
export class SweepScheduler {
  private running: Promise<void> | undefined;
  private queuedReason: string | undefined;
  private lastRunAt = 0;

  constructor(
    private readonly run: (reason: string) => Promise<void>,
    private readonly log: Logger = nullLogger,
  ) {}

  /** `minIntervalMs` throttles chatty triggers such as window-focus changes. */
  request(reason: string, minIntervalMs = 0): void {
    if (minIntervalMs > 0 && Date.now() - this.lastRunAt < minIntervalMs) {
      this.log.debug(`Sweep "${reason}" throttled.`);
      return;
    }
    if (this.running) {
      // Collapse: one more run after the current one is all that is ever needed.
      this.queuedReason = reason;
      return;
    }
    void this.execute(reason);
  }

  private async execute(reason: string): Promise<void> {
    this.running = (async () => {
      try {
        await this.run(reason);
      } catch (err) {
        this.log.error(`Sweep "${reason}" failed: ${String(err)}`);
      } finally {
        this.lastRunAt = Date.now();
      }
    })();

    await this.running;
    this.running = undefined;

    const queued = this.queuedReason;
    this.queuedReason = undefined;
    if (queued) void this.execute(queued);
  }

  /** Awaits any sweep currently in flight. Used by tests and by dispose. */
  async settled(): Promise<void> {
    while (this.running) {
      await this.running;
    }
  }
}
