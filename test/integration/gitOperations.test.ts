import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../../src/config';
import {
  ChangeDetector,
  type BurstSettledEvent,
} from '../../src/detect/ChangeDetector';
import { GitOpMonitor, resolveGitDir } from '../../src/detect/GitOpMonitor';
import { createMemoryLogger } from '../../src/log';
import {
  git,
  initBareRepo,
  initRealRepo,
  makeTempWorkspace,
  sleep,
  type TempWorkspace,
} from '../helpers/tmp';

/**
 * §13.2 / §6.8 — real git operations against a real repository.
 *
 * The risk this guards is specific and dangerous: if a `git pull` is classified
 * as an agent write, 200 files land in the pending list and **Reject All undoes
 * the pull**. Two layers are tested here — that our marker list actually covers
 * each operation, and that the end-to-end monitor observes them.
 */

let ws: TempWorkspace;
const log = createMemoryLogger();

/** Marker files and directories the monitor watches (mirrors GitOpMonitor). */
const MARKERS = [
  'HEAD',
  'ORIG_HEAD',
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'REBASE_HEAD',
  'packed-refs',
  'refs/stash',
  'rebase-merge',
  'rebase-apply',
];

/** Snapshot of every marker's existence and mtime. */
async function markerSnapshot(gitDir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const marker of MARKERS) {
    try {
      const st = await fs.stat(path.join(gitDir, marker));
      out[marker] = `${st.mtimeMs}:${st.size}`;
    } catch {
      out[marker] = 'absent';
    }
  }
  // Branch refs live under refs/heads and move on a fast-forward pull.
  try {
    const heads = await fs.readdir(path.join(gitDir, 'refs', 'heads'));
    for (const head of heads) {
      const st = await fs.stat(path.join(gitDir, 'refs', 'heads', head));
      out[`refs/heads/${head}`] = `${st.mtimeMs}:${st.size}`;
    }
  } catch {
    /* no loose branch refs */
  }
  return out;
}

function changedMarkers(
  before: Record<string, string>,
  after: Record<string, string>,
): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => before[k] !== after[k]);
}

beforeEach(async () => {
  ws = await makeTempWorkspace('lfct-gitop-');
});

afterEach(async () => {
  await ws.cleanup();
});

describe('marker coverage — every work-tree-rewriting operation moves something we watch', () => {
  async function repoWithHistory(): Promise<string> {
    await initRealRepo(ws.root);
    await ws.file('a.txt', 'v1\n');
    await ws.file('b.txt', 'b1\n');
    await git(ws.root, ['add', '-A']);
    await git(ws.root, ['commit', '-q', '-m', 'first']);
    await ws.file('a.txt', 'v2\n');
    await git(ws.root, ['add', '-A']);
    await git(ws.root, ['commit', '-q', '-m', 'second']);
    return path.join(ws.root, '.git');
  }

  it('reset --hard moves ORIG_HEAD', async () => {
    const gitDir = await repoWithHistory();
    const before = await markerSnapshot(gitDir);
    await sleep(20);
    await git(ws.root, ['reset', '--hard', 'HEAD~1']);
    expect(changedMarkers(before, await markerSnapshot(gitDir))).toContain('ORIG_HEAD');
  });

  it('checkout <branch> moves HEAD', async () => {
    const gitDir = await repoWithHistory();
    await git(ws.root, ['branch', 'feature', 'HEAD~1']);
    const before = await markerSnapshot(gitDir);
    await sleep(20);
    await git(ws.root, ['checkout', '--quiet', 'feature']);
    expect(changedMarkers(before, await markerSnapshot(gitDir))).toContain('HEAD');
  });

  it('stash push moves refs/stash', async () => {
    const gitDir = await repoWithHistory();
    await ws.file('a.txt', 'dirty\n');
    const before = await markerSnapshot(gitDir);
    await sleep(20);
    await git(ws.root, ['stash', 'push', '--quiet']);
    // HEAD stays exactly where it was, which is why the Git extension's API
    // alone cannot see this one.
    expect(changedMarkers(before, await markerSnapshot(gitDir))).toContain('refs/stash');
  });

  it('stash pop moves refs/stash again', async () => {
    const gitDir = await repoWithHistory();
    await ws.file('a.txt', 'dirty\n');
    await git(ws.root, ['stash', 'push', '--quiet']);
    const before = await markerSnapshot(gitDir);
    await sleep(20);
    await git(ws.root, ['stash', 'pop', '--quiet']);
    expect(changedMarkers(before, await markerSnapshot(gitDir)).length).toBeGreaterThan(0);
  });

  it('merge moves ORIG_HEAD and the branch ref', async () => {
    const gitDir = await repoWithHistory();
    await git(ws.root, ['checkout', '--quiet', '-b', 'feature', 'HEAD~1']);
    await ws.file('c.txt', 'c\n');
    await git(ws.root, ['add', '-A']);
    await git(ws.root, ['commit', '-q', '-m', 'feature work']);
    await git(ws.root, ['checkout', '--quiet', 'main']);

    const before = await markerSnapshot(gitDir);
    await sleep(20);
    await git(ws.root, ['merge', '--quiet', '--no-edit', 'feature']);
    const changed = changedMarkers(before, await markerSnapshot(gitDir));
    expect(changed.some((m) => m === 'ORIG_HEAD' || m.startsWith('refs/heads/'))).toBe(true);
  });

  it('rebase moves a marker', async () => {
    const gitDir = await repoWithHistory();
    await git(ws.root, ['checkout', '--quiet', '-b', 'feature', 'HEAD~1']);
    await ws.file('c.txt', 'c\n');
    await git(ws.root, ['add', '-A']);
    await git(ws.root, ['commit', '-q', '-m', 'feature work']);

    const before = await markerSnapshot(gitDir);
    await sleep(20);
    await git(ws.root, ['rebase', '--quiet', 'main']);
    const changed = changedMarkers(before, await markerSnapshot(gitDir));
    expect(changed.length).toBeGreaterThan(0);
  });

  it('pull from a local bare remote moves ORIG_HEAD or the branch ref', async () => {
    // Full S9: an upstream commit lands and rewrites the work tree.
    const remote = path.join(path.dirname(ws.root), 'remote.git');
    const other = path.join(path.dirname(ws.root), 'other');

    await initRealRepo(ws.root);
    await ws.file('a.txt', 'v1\n');
    await git(ws.root, ['add', '-A']);
    await git(ws.root, ['commit', '-q', '-m', 'first']);

    await fs.mkdir(remote, { recursive: true });
    await initBareRepo(remote);
    await git(ws.root, ['remote', 'add', 'origin', remote]);
    await git(ws.root, ['push', '--quiet', '-u', 'origin', 'main']);

    await fs.mkdir(other, { recursive: true });
    await git(path.dirname(other), ['clone', '--quiet', remote, 'other']);
    await git(other, ['config', 'user.name', 'Other']);
    await git(other, ['config', 'user.email', 'other@example.com']);
    await fs.writeFile(path.join(other, 'a.txt'), 'v2-from-upstream\n');
    await fs.writeFile(path.join(other, 'new-upstream.txt'), 'new\n');
    await git(other, ['add', '-A']);
    await git(other, ['commit', '-q', '-m', 'upstream work']);
    await git(other, ['push', '--quiet', 'origin', 'main']);

    const gitDir = path.join(ws.root, '.git');
    const before = await markerSnapshot(gitDir);
    await sleep(20);
    await git(ws.root, ['pull', '--quiet', '--ff-only', 'origin', 'main']);

    expect(await ws.readText('a.txt')).toBe('v2-from-upstream\n');
    const changed = changedMarkers(before, await markerSnapshot(gitDir));
    expect(
      changed.some((m) => m === 'ORIG_HEAD' || m.startsWith('refs/heads/') || m === 'HEAD'),
      `expected a watched marker to move, got ${JSON.stringify(changed)}`,
    ).toBe(true);
  });

  it('E10b — checkout -- . rewrites the work tree without moving any marker', async () => {
    // Documented gap: this falls through to agent classification and surfaces
    // as pending. Harmless, because Accept All resolves it.
    const gitDir = await repoWithHistory();
    await ws.file('a.txt', 'dirty\n');
    const before = await markerSnapshot(gitDir);
    await sleep(20);
    await git(ws.root, ['checkout', '--', '.']);
    expect(changedMarkers(before, await markerSnapshot(gitDir))).toEqual([]);
  });
});

describe('GitOpMonitor end to end', () => {
  it('is inert when the workspace is not a git repository', async () => {
    const monitor = new GitOpMonitor({ worktree: ws.root, log });
    await monitor.start();
    expect(monitor.tracker.active).toBe(false);
    monitor.dispose();
  });

  it('resolves a .git file pointing elsewhere (linked worktree / submodule)', async () => {
    const realGitDir = path.join(path.dirname(ws.root), 'actual-git-dir');
    await fs.mkdir(realGitDir, { recursive: true });
    await fs.writeFile(path.join(ws.root, '.git'), `gitdir: ${realGitDir}\n`);
    expect(await resolveGitDir(ws.root)).toBe(realGitDir);
  });

  it('records a marker move when a real git operation runs', async () => {
    await initRealRepo(ws.root);
    await ws.file('a.txt', 'v1\n');
    await git(ws.root, ['add', '-A']);
    await git(ws.root, ['commit', '-q', '-m', 'first']);
    await ws.file('a.txt', 'v2\n');
    await git(ws.root, ['add', '-A']);
    await git(ws.root, ['commit', '-q', '-m', 'second']);

    const monitor = new GitOpMonitor({ worktree: ws.root, log });
    await monitor.start();
    expect(monitor.tracker.active).toBe(true);

    try {
      const from = Date.now();
      await sleep(50);
      await git(ws.root, ['reset', '--hard', 'HEAD~1']);
      // fs.watch is asynchronous; give the event loop room to deliver.
      await sleep(600);
      expect(
        monitor.tracker.movedWithin(from, Date.now()),
        `expected a marker within the window; recorded ${JSON.stringify(
          monitor.tracker.recordsWithin(from, Date.now()),
        )}`,
      ).toBe(true);
    } finally {
      monitor.dispose();
    }
  });

  /**
   * A branch name is a path. `feature/login` lives at
   * `refs/heads/feature/login`, one directory below the level a plain watch
   * covers, so a non-recursive watch on `refs/heads` was blind to it — and a
   * fast-forward pull on such a branch looked exactly like an agent burst.
   */
  it('sees a ref move on a branch whose name contains a slash', async () => {
    await initRealRepo(ws.root);
    await ws.file('a.txt', 'v1\n');
    await git(ws.root, ['add', '-A']);
    await git(ws.root, ['commit', '-q', '-m', 'first']);
    await git(ws.root, ['checkout', '-q', '-b', 'feature/login']);

    const monitor = new GitOpMonitor({ worktree: ws.root, log });
    await monitor.start();

    try {
      const from = Date.now();
      await sleep(50);
      // Moves refs/heads/feature/login, and nothing at the top level of refs/heads.
      await ws.file('a.txt', 'v2\n');
      await git(ws.root, ['add', '-A']);
      await git(ws.root, ['commit', '-q', '-m', 'second']);
      await sleep(600);

      const seen = monitor.tracker.recordsWithin(from, Date.now());
      expect(
        seen.some((r) => r.source.includes('refs/heads/feature/login')),
        `expected the nested ref among ${JSON.stringify(seen.map((r) => r.source))}`,
      ).toBe(true);
    } finally {
      monitor.dispose();
    }
  });

  it('picks up a branch directory created after the monitor started', async () => {
    await initRealRepo(ws.root);
    await ws.file('a.txt', 'v1\n');
    await git(ws.root, ['add', '-A']);
    await git(ws.root, ['commit', '-q', '-m', 'first']);

    // No refs/heads subdirectory exists yet, so the fallback path has nothing
    // to enumerate at startup and must adopt `fix/` when it appears.
    const monitor = new GitOpMonitor({ worktree: ws.root, log });
    await monitor.start();

    try {
      await git(ws.root, ['checkout', '-q', '-b', 'fix/typo']);
      await sleep(300);

      const from = Date.now();
      await sleep(50);
      await ws.file('a.txt', 'v2\n');
      await git(ws.root, ['add', '-A']);
      await git(ws.root, ['commit', '-q', '-m', 'second']);
      await sleep(600);

      // Asserted on the nested source specifically: `git commit` also touches
      // .git/HEAD, so `movedWithin` alone would pass without the subdirectory
      // ever being watched.
      const seen = monitor.tracker.recordsWithin(from, Date.now());
      expect(
        seen.some((r) => r.source.includes('refs/heads/fix/typo')),
        `expected the nested ref among ${JSON.stringify(seen.map((r) => r.source))}`,
      ).toBe(true);
    } finally {
      monitor.dispose();
    }
  });

  it('classifies a burst as git when the monitor saw the operation (S9)', async () => {
    await initRealRepo(ws.root);
    for (let i = 0; i < 5; i++) await ws.file(`f${i}.txt`, 'v1\n');
    await git(ws.root, ['add', '-A']);
    await git(ws.root, ['commit', '-q', '-m', 'first']);
    for (let i = 0; i < 5; i++) await ws.file(`f${i}.txt`, 'v2\n');
    await git(ws.root, ['add', '-A']);
    await git(ws.root, ['commit', '-q', '-m', 'second']);

    const monitor = new GitOpMonitor({ worktree: ws.root, log });
    await monitor.start();

    const bursts: BurstSettledEvent[] = [];
    const detector = new ChangeDetector({
      config: { ...DEFAULT_CONFIG, burstQuietMs: 300 },
      isTracked: () => true,
      gitMarkers: monitor.tracker,
      log,
    });
    detector.onBurstSettled((e) => bursts.push(e));
    detector.start();

    try {
      await git(ws.root, ['reset', '--hard', 'HEAD~1']);
      await sleep(150);
      // Feed the work-tree writes the way the watcher would.
      for (let i = 0; i < 5; i++) {
        detector.handleFsEvent({ absPath: ws.abs(`f${i}.txt`), kind: 'change' });
      }
      await sleep(800);

      expect(bursts).toHaveLength(1);
      expect(bursts[0].origin).toBe('git');
      expect(bursts[0].paths).toHaveLength(5);
    } finally {
      detector.dispose();
      monitor.dispose();
    }
  });

  it('classifies an ordinary write as agent when no git operation happened', async () => {
    await initRealRepo(ws.root);
    await ws.file('a.txt', 'v1\n');
    await git(ws.root, ['add', '-A']);
    await git(ws.root, ['commit', '-q', '-m', 'first']);

    const monitor = new GitOpMonitor({ worktree: ws.root, log });
    await monitor.start();

    const bursts: BurstSettledEvent[] = [];
    const detector = new ChangeDetector({
      config: { ...DEFAULT_CONFIG, burstQuietMs: 300 },
      isTracked: () => true,
      gitMarkers: monitor.tracker,
      log,
    });
    detector.onBurstSettled((e) => bursts.push(e));
    detector.start();

    try {
      // Wait past any marker churn left over from the fixture commits.
      await sleep(DEFAULT_CONFIG.gitOpWindowMs + 300);
      await ws.file('a.txt', 'written by an agent\n');
      detector.handleFsEvent({ absPath: ws.abs('a.txt'), kind: 'change' });
      await sleep(800);

      expect(bursts).toHaveLength(1);
      expect(bursts[0].origin).toBe('agent');
    } finally {
      detector.dispose();
      monitor.dispose();
    }
  });

  it('a git command that only reads does not record a marker', async () => {
    await initRealRepo(ws.root);
    await ws.file('a.txt', 'v1\n');
    await git(ws.root, ['add', '-A']);
    await git(ws.root, ['commit', '-q', '-m', 'first']);

    const monitor = new GitOpMonitor({ worktree: ws.root, log });
    await monitor.start();
    try {
      await sleep(100);
      const from = Date.now();
      // `git status` writes .git/index and index.lock constantly — a shell
      // prompt may run it every keystroke. Treating that as an operation would
      // auto-accept every agent burst.
      await git(ws.root, ['status', '--porcelain']);
      await git(ws.root, ['log', '--oneline']);
      await sleep(500);
      expect(monitor.tracker.movedWithin(from, Date.now())).toBe(false);
    } finally {
      monitor.dispose();
    }
  });
});
