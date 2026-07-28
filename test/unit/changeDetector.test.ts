import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, type LfctConfig } from '../../src/config';
import {
  ChangeDetector,
  type BurstSettledEvent,
  type DetectorClock,
  type GitMarkerSource,
} from '../../src/detect/ChangeDetector';

/**
 * §13.1 — synthetic event sequences against a fully controlled clock, so
 * expected-write expiry, suppression, burst coalescing and the git-correlation
 * window are all exercised at their exact boundaries rather than by sleeping.
 */

interface ScheduledTask {
  id: number;
  fireAt: number;
  fn: () => void;
}

class FakeClock implements DetectorClock {
  private current = 1_000_000;
  private tasks: ScheduledTask[] = [];
  private nextId = 1;

  now(): number {
    return this.current;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const task = { id: this.nextId++, fireAt: this.current + ms, fn };
    this.tasks.push(task);
    return task.id;
  }

  clearTimeout(handle: unknown): void {
    this.tasks = this.tasks.filter((t) => t.id !== handle);
  }

  /** Advances time, firing anything scheduled along the way in order. */
  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      const due = this.tasks
        .filter((t) => t.fireAt <= target)
        .sort((a, b) => a.fireAt - b.fireAt)[0];
      if (!due) break;
      this.tasks = this.tasks.filter((t) => t.id !== due.id);
      this.current = due.fireAt;
      due.fn();
    }
    this.current = target;
  }
}

class FakeMarkers implements GitMarkerSource {
  active = true;
  private times: number[] = [];

  record(at: number): void {
    this.times.push(at);
  }

  movedWithin(fromMs: number, toMs: number): boolean {
    return this.times.some((t) => t >= fromMs && t <= toMs);
  }
}

const P = (name: string) => `/ws/${name}`;

interface Harness {
  detector: ChangeDetector;
  clock: FakeClock;
  markers: FakeMarkers;
  bursts: BurstSettledEvent[];
  userEdits: string[][];
  sweeps: string[];
}

function harness(config: Partial<LfctConfig> = {}, tracked = (_p: string) => true): Harness {
  const clock = new FakeClock();
  const markers = new FakeMarkers();
  const bursts: BurstSettledEvent[] = [];
  const userEdits: string[][] = [];
  const sweeps: string[] = [];

  const detector = new ChangeDetector({
    config: { ...DEFAULT_CONFIG, ...config },
    isTracked: tracked,
    gitMarkers: markers,
    clock,
  });
  detector.onBurstSettled((e) => bursts.push(e));
  detector.onUserEdit((paths) => userEdits.push(paths));
  detector.onSweepRequested((e) => sweeps.push(e.reason));
  detector.start();

  return { detector, clock, markers, bursts, userEdits, sweeps };
}

let h: Harness;
beforeEach(() => {
  h = harness();
});

describe('ChangeDetector — external writes (S2)', () => {
  it('coalesces a burst into one settled event', () => {
    h.detector.handleFsEvent({ absPath: P('app.ts'), kind: 'change' });
    h.clock.advance(200);
    h.detector.handleFsEvent({ absPath: P('utils.ts'), kind: 'change' });
    h.clock.advance(200);
    h.detector.handleFsEvent({ absPath: P('generated.ts'), kind: 'create' });

    expect(h.bursts).toHaveLength(0);
    h.clock.advance(DEFAULT_CONFIG.burstQuietMs);

    expect(h.bursts).toHaveLength(1);
    expect(h.bursts[0].origin).toBe('agent');
    expect(h.bursts[0].paths.sort()).toEqual(
      [P('app.ts'), P('generated.ts'), P('utils.ts')].sort(),
    );
  });

  it('does not settle while writes keep arriving', () => {
    for (let i = 0; i < 10; i++) {
      h.detector.handleFsEvent({ absPath: P(`f${i}.ts`), kind: 'change' });
      h.clock.advance(DEFAULT_CONFIG.burstQuietMs - 1);
    }
    expect(h.bursts).toHaveLength(0);
    h.clock.advance(DEFAULT_CONFIG.burstQuietMs);
    expect(h.bursts).toHaveLength(1);
    expect(h.bursts[0].paths).toHaveLength(10);
  });

  it('deduplicates repeated writes to one file (E16)', () => {
    for (let i = 0; i < 50; i++) {
      h.detector.handleFsEvent({ absPath: P('app.ts'), kind: 'change' });
      h.clock.advance(10);
    }
    h.clock.advance(DEFAULT_CONFIG.burstQuietMs);
    expect(h.bursts).toHaveLength(1);
    expect(h.bursts[0].paths).toEqual([P('app.ts')]);
  });

  it('ignores paths the denylist rejects', () => {
    const local = harness({}, (p) => !p.includes('node_modules'));
    local.detector.handleFsEvent({ absPath: P('node_modules/x/index.js'), kind: 'change' });
    local.detector.handleFsEvent({ absPath: P('src/app.ts'), kind: 'change' });
    local.clock.advance(DEFAULT_CONFIG.burstQuietMs);
    expect(local.bursts[0].paths).toEqual([P('src/app.ts')]);
  });
});

describe('ChangeDetector — user edits (S5, §6.4)', () => {
  it('attributes an anticipated save as a user edit and surfaces nothing', () => {
    h.detector.noteExpectedWrite(P('app.ts'));
    h.clock.advance(50);
    h.detector.handleFsEvent({ absPath: P('app.ts'), kind: 'change' });

    h.clock.advance(1000);
    expect(h.bursts).toHaveLength(0);
    expect(h.userEdits).toEqual([[P('app.ts')]]);
  });

  it('batches saves inside the debounce window (P4)', () => {
    h.detector.noteExpectedWrite(P('a.ts'));
    h.detector.handleFsEvent({ absPath: P('a.ts'), kind: 'change' });
    h.clock.advance(100);
    h.detector.noteExpectedWrite(P('b.ts'));
    h.detector.handleFsEvent({ absPath: P('b.ts'), kind: 'change' });

    h.clock.advance(1000);
    expect(h.userEdits).toHaveLength(1);
    expect(h.userEdits[0].sort()).toEqual([P('a.ts'), P('b.ts')].sort());
  });

  it('consumes the expectation, so a second write to the same path is external', () => {
    h.detector.noteExpectedWrite(P('app.ts'));
    h.detector.handleFsEvent({ absPath: P('app.ts'), kind: 'change' });
    h.clock.advance(10);
    h.detector.handleFsEvent({ absPath: P('app.ts'), kind: 'change' });

    h.clock.advance(1000);
    expect(h.userEdits).toEqual([[P('app.ts')]]);
    expect(h.bursts).toHaveLength(1);
    expect(h.bursts[0].paths).toEqual([P('app.ts')]);
  });

  it('expires an expectation past the grace window (§6.3)', () => {
    h.detector.noteExpectedWrite(P('app.ts'));
    // A watcher event that never arrived would otherwise leave this entry
    // forever, misclassifying a later agent write to the same path.
    h.clock.advance(DEFAULT_CONFIG.userEditGraceMs + 1);
    h.detector.handleFsEvent({ absPath: P('app.ts'), kind: 'change' });

    h.clock.advance(1000);
    expect(h.userEdits).toHaveLength(0);
    expect(h.bursts[0].paths).toEqual([P('app.ts')]);
  });

  it('accepts an expectation exactly at the grace boundary', () => {
    h.detector.noteExpectedWrite(P('app.ts'));
    h.clock.advance(DEFAULT_CONFIG.userEditGraceMs);
    h.detector.handleFsEvent({ absPath: P('app.ts'), kind: 'change' });
    h.clock.advance(1000);
    expect(h.userEdits).toEqual([[P('app.ts')]]);
  });

  it('handles interleaved user and agent writes to different paths', () => {
    h.detector.noteExpectedWrite(P('mine.ts'));
    h.detector.handleFsEvent({ absPath: P('mine.ts'), kind: 'change' });
    h.detector.handleFsEvent({ absPath: P('theirs.ts'), kind: 'change' });

    h.clock.advance(1000);
    expect(h.userEdits).toEqual([[P('mine.ts')]]);
    expect(h.bursts[0].paths).toEqual([P('theirs.ts')]);
  });

  it('marks both sides of an Explorer rename as expected (§6.9)', () => {
    h.detector.noteExpectedWrites([P('old.ts'), P('new.ts')]);
    h.detector.handleFsEvent({ absPath: P('old.ts'), kind: 'delete' });
    h.detector.handleFsEvent({ absPath: P('new.ts'), kind: 'create' });

    h.clock.advance(1000);
    expect(h.bursts).toHaveLength(0);
    expect(h.userEdits[0].sort()).toEqual([P('new.ts'), P('old.ts')].sort());
  });
});

describe('ChangeDetector — suppression (§6.6, E2)', () => {
  it('swallows our own restore write', () => {
    h.detector.suppressPath(P('app.ts'));
    h.detector.handleFsEvent({ absPath: P('app.ts'), kind: 'change' });
    h.clock.advance(1000);
    expect(h.bursts).toHaveLength(0);
    expect(h.userEdits).toHaveLength(0);
  });

  it('swallows several events for one restore, so the file is never re-listed', () => {
    // A single `git checkout` can produce more than one watcher event. Clearing
    // suppression on the first match would re-list the file we just restored.
    h.detector.suppressPath(P('app.ts'));
    h.detector.handleFsEvent({ absPath: P('app.ts'), kind: 'delete' });
    h.detector.handleFsEvent({ absPath: P('app.ts'), kind: 'create' });
    h.detector.handleFsEvent({ absPath: P('app.ts'), kind: 'change' });
    h.clock.advance(1000);
    expect(h.bursts).toHaveLength(0);
  });

  it('expires so a genuine later agent write is still caught', () => {
    h.detector.suppressPath(P('app.ts'));
    h.clock.advance(5000);
    h.detector.handleFsEvent({ absPath: P('app.ts'), kind: 'change' });
    h.clock.advance(1000);
    expect(h.bursts[0].paths).toEqual([P('app.ts')]);
  });

  it('forgetPending drops a path from an open burst', () => {
    h.detector.handleFsEvent({ absPath: P('a.ts'), kind: 'change' });
    h.detector.handleFsEvent({ absPath: P('b.ts'), kind: 'change' });
    h.detector.forgetPending(P('a.ts'));
    h.clock.advance(1000);
    expect(h.bursts[0].paths).toEqual([P('b.ts')]);
  });
});

describe('ChangeDetector — git correlation (§6.8, S9)', () => {
  it('classifies a burst as git when a marker moved inside the window', () => {
    const at = h.clock.now();
    h.markers.record(at + 100);
    h.detector.handleFsEvent({ absPath: P('a.ts'), kind: 'change' });
    h.clock.advance(1000);
    expect(h.bursts[0].origin).toBe('git');
  });

  it('tolerates a marker that moved just before the burst started', () => {
    // `git reset --hard` writes ORIG_HEAD *before* it rewrites the work tree.
    const at = h.clock.now();
    h.markers.record(at - DEFAULT_CONFIG.gitOpWindowMs + 1);
    h.detector.handleFsEvent({ absPath: P('a.ts'), kind: 'change' });
    h.clock.advance(1000);
    expect(h.bursts[0].origin).toBe('git');
  });

  it('rejects a marker older than the window', () => {
    const at = h.clock.now();
    h.markers.record(at - DEFAULT_CONFIG.gitOpWindowMs - 1);
    h.detector.handleFsEvent({ absPath: P('a.ts'), kind: 'change' });
    h.clock.advance(1000);
    expect(h.bursts[0].origin).toBe('agent');
  });

  it('classifies as git when the marker moves after the last write but before settle', () => {
    // `git checkout <branch>` writes the work tree, then updates HEAD.
    h.detector.handleFsEvent({ absPath: P('a.ts'), kind: 'change' });
    h.clock.advance(100);
    h.markers.record(h.clock.now());
    h.clock.advance(1000);
    expect(h.bursts[0].origin).toBe('git');
  });

  it('stays agent-classified when the repository is not a git repo', () => {
    h.markers.active = false;
    h.markers.record(h.clock.now());
    h.detector.handleFsEvent({ absPath: P('a.ts'), kind: 'change' });
    h.clock.advance(1000);
    expect(h.bursts[0].origin).toBe('agent');
  });

  it('E10b — a git operation that moves no marker falls through to agent', () => {
    h.detector.handleFsEvent({ absPath: P('a.ts'), kind: 'change' });
    h.clock.advance(1000);
    expect(h.bursts[0].origin).toBe('agent');
  });
});

describe('ChangeDetector — directory events (§6.9, E10c)', () => {
  it('forces a sweep instead of trusting per-file events', () => {
    h.detector.handleFsEvent({ absPath: P('lib'), kind: 'create', isDirectory: true });
    expect(h.sweeps).toEqual(['directory-create']);
    // The directory itself must not enter the pending list.
    h.clock.advance(1000);
    expect(h.bursts).toHaveLength(0);
  });

  it('sweeps on a directory delete too', () => {
    h.detector.handleFsEvent({ absPath: P('src'), kind: 'delete', isDirectory: true });
    expect(h.sweeps).toEqual(['directory-delete']);
  });

  it('does not sweep on a directory change event', () => {
    h.detector.handleFsEvent({ absPath: P('src'), kind: 'change', isDirectory: true });
    expect(h.sweeps).toEqual([]);
  });

  it('a suppressed directory event is swallowed before the sweep', () => {
    h.detector.suppressPath(P('lib'));
    h.detector.handleFsEvent({ absPath: P('lib'), kind: 'delete', isDirectory: true });
    expect(h.sweeps).toEqual([]);
  });
});

describe('ChangeDetector — lifecycle', () => {
  it('ignores events before start()', () => {
    const clock = new FakeClock();
    const bursts: BurstSettledEvent[] = [];
    const detector = new ChangeDetector({
      config: DEFAULT_CONFIG,
      isTracked: () => true,
      gitMarkers: new FakeMarkers(),
      clock,
    });
    detector.onBurstSettled((e) => bursts.push(e));
    detector.handleFsEvent({ absPath: P('a.ts'), kind: 'change' });
    clock.advance(1000);
    expect(bursts).toHaveLength(0);
  });

  it('ignores events after dispose()', () => {
    h.detector.dispose();
    h.detector.handleFsEvent({ absPath: P('a.ts'), kind: 'change' });
    h.clock.advance(1000);
    expect(h.bursts).toHaveLength(0);
  });

  /**
   * A Reject All arms one suppression entry per file. They used to drain only
   * when that exact path saw another watcher event, because the sweep sat
   * behind an early-out on a different map — so the entries outlived the window.
   */
  it('drains suppression entries once their TTL has passed', () => {
    for (let i = 0; i < 200; i++) h.detector.suppressPath(P(`file${i}.ts`));
    expect(h.detector.state.suppressed).toBe(200);

    // Unrelated activity, well past the 2s suppression TTL.
    h.clock.advance(60_000);
    h.detector.handleFsEvent({ absPath: P('unrelated.ts'), kind: 'change' });

    expect(h.detector.state.suppressed).toBe(0);
  });

  it('still suppresses a self-write that lands inside the TTL', () => {
    h.detector.suppressPath(P('restored.ts'));
    h.clock.advance(500);
    h.detector.handleFsEvent({ absPath: P('restored.ts'), kind: 'change' });
    h.clock.advance(5000);

    expect(h.bursts).toHaveLength(0);
  });

  it('picks up a changed burst window from updateConfig', () => {
    h.detector.updateConfig({ ...DEFAULT_CONFIG, burstQuietMs: 5000 });
    h.detector.handleFsEvent({ absPath: P('a.ts'), kind: 'change' });
    h.clock.advance(1000);
    expect(h.bursts).toHaveLength(0);
    h.clock.advance(5000);
    expect(h.bursts).toHaveLength(1);
  });
});
