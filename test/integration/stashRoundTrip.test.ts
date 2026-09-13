import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../../src/config';
import { reconcile } from '../../src/detect/reconcile';
import { ReviewParking } from '../../src/detect/ReviewParking';
import { createMemoryLogger } from '../../src/log';
import { IgnoreRules } from '../../src/scan/IgnoreRules';
import { WorkspaceWalker } from '../../src/scan/WorkspaceWalker';
import { CheckpointStore, type FileStatus } from '../../src/store/CheckpointStore';
import {
  git,
  initRealRepo,
  makeTempWorkspace,
  realGitVersion,
  type TempWorkspace,
} from '../helpers/tmp';

/**
 * §6.8 — a stash round trip, with real git on both sides.
 *
 * Git operations are auto-accepted. `git stash` then `git stash pop` used to be
 * two unrelated accepts, which silently accepted every pending change the stash
 * had only set aside. Each test drives what the extension does: sweep, then
 * accept (git burst) or restore (agent burst) the paths the burst reported.
 */

let ws: TempWorkspace;
let store: CheckpointStore | undefined;
const log = createMemoryLogger();

beforeEach(async () => {
  ws = await makeTempWorkspace('lfct-stash-');
});

afterEach(async () => {
  store?.dispose();
  store = undefined;
  await ws.cleanup();
});

async function openStore(): Promise<{ store: CheckpointStore; walker: WorkspaceWalker }> {
  store = await CheckpointStore.open({
    storagePath: ws.storage,
    worktree: ws.root,
    version: await realGitVersion(),
    extensionVersion: '0.1.0-test',
    log,
  });
  const walker = new WorkspaceWalker(ws.root, new IgnoreRules(ws.root, DEFAULT_CONFIG, ws.storage), log);
  await store.createInitialBaseline(await walker.walk());
  return { store, walker };
}

/** A committed repository, a baseline of it, and the sweep the extension runs. */
async function setup(files: Record<string, string>) {
  await initRealRepo(ws.root);
  for (const [rel, content] of Object.entries(files)) await ws.file(rel, content);
  await git(ws.root, ['add', '-A']);
  await git(ws.root, ['commit', '-q', '-m', 'first']);

  const { store, walker } = await openStore();
  const parking = new ReviewParking(store, ws.storage, log);
  const sweep = async (with_ = parking): Promise<FileStatus[]> => {
    const { statuses } = await reconcile(store, walker, log);
    await with_.observe(statuses);
    return statuses;
  };
  return { store, parking, sweep };
}

describe('stash round trip', () => {
  it('lists pending changes again after stash push -u and pop', async () => {
    const h = await setup({ 'a.txt': 'one\ntwo\n', 'gone.txt': 'keep me\n' });
    await ws.file('a.txt', 'one\nagent\n');
    await ws.file('new.txt', 'created by an agent\n');
    await ws.remove('gone.txt');
    const before = await h.sweep();
    const patchBefore = await h.store.readPatch('a.txt', 'M');
    const touched = ['a.txt', 'gone.txt', 'new.txt'];

    await git(ws.root, ['stash', 'push', '-u', '-q']);
    expect((await h.parking.acceptGitOperation(touched, 'git operation')).restored).toEqual([]);
    expect(await h.sweep()).toEqual([]);

    await git(ws.root, ['stash', 'pop', '-q']);
    const popped = await h.parking.acceptGitOperation(touched, 'git operation');
    expect(popped.restored.sort()).toEqual(touched);
    expect(popped.accepted).toEqual([]);

    expect(await h.sweep()).toEqual(before);
    expect(await h.store.readPatch('a.txt', 'M')).toBe(patchBefore);
    expect(h.parking.parkedPaths).toEqual([]);
  });

  it('keeps your own saved edits out of the review after a pop', async () => {
    // The baseline already holds an edit you saved but never committed, so
    // the stash takes that too. Only the agent's line may come back as pending.
    const h = await setup({ 'a.txt': 'one\n' });
    await ws.file('a.txt', 'one\nmine\n');
    await h.store.commitPaths(['a.txt'], 'user edit');
    await ws.file('a.txt', 'one\nmine\nagent\n');
    await h.sweep();
    const patchBefore = await h.store.readPatch('a.txt', 'M');

    await git(ws.root, ['stash', 'push', '-q']);
    await h.parking.acceptGitOperation(['a.txt'], 'git operation');
    await git(ws.root, ['stash', 'pop', '-q']);
    await h.parking.acceptGitOperation(['a.txt'], 'git operation');

    expect(await h.sweep()).toEqual([{ relPath: 'a.txt', status: 'M' }]);
    expect(await h.store.readPatch('a.txt', 'M')).toBe(patchBefore);
  });

  it('restores through the agent-burst path for stash apply, which moves no marker', async () => {
    const h = await setup({ 'a.txt': 'one\n' });
    await ws.file('a.txt', 'one\nmine\n');
    await h.store.commitPaths(['a.txt'], 'user edit');
    await ws.file('a.txt', 'one\nmine\nagent\n');
    await h.sweep();
    const patchBefore = await h.store.readPatch('a.txt', 'M');

    await git(ws.root, ['stash', 'push', '-q']);
    await h.parking.acceptGitOperation(['a.txt'], 'git operation');
    await git(ws.root, ['stash', 'apply', '-q']);
    expect(await h.parking.restoreReturning(['a.txt'])).toEqual(['a.txt']);

    expect(await h.sweep()).toEqual([{ relPath: 'a.txt', status: 'M' }]);
    expect(await h.store.readPatch('a.txt', 'M')).toBe(patchBefore);
  });

  it('survives a window reload between the stash and the pop', async () => {
    const h = await setup({ 'a.txt': 'one\n' });
    await ws.file('a.txt', 'agent\n');
    const before = await h.sweep();

    await git(ws.root, ['stash', 'push', '-q']);
    await h.parking.acceptGitOperation(['a.txt'], 'git operation');

    const reloaded = new ReviewParking(h.store, ws.storage, log);
    await reloaded.load();
    expect(reloaded.parkedPaths).toEqual(['a.txt']);

    await git(ws.root, ['stash', 'pop', '-q']);
    expect((await reloaded.acceptGitOperation(['a.txt'], 'git operation')).restored).toEqual(['a.txt']);
    expect(await h.sweep(reloaded)).toEqual(before);
  });

  it('still auto-accepts a git operation that brings different content', async () => {
    const h = await setup({ 'a.txt': 'one\n' });
    await git(ws.root, ['checkout', '-q', '-b', 'other']);
    await ws.file('a.txt', 'from another branch\n');
    await git(ws.root, ['commit', '-q', '-am', 'other']);
    await git(ws.root, ['checkout', '-q', 'main']);

    await ws.file('a.txt', 'agent\n');
    await h.sweep();
    await git(ws.root, ['stash', 'push', '-q']);
    await h.parking.acceptGitOperation(['a.txt'], 'git operation');
    expect(h.parking.parkedPaths).toEqual(['a.txt']);

    await git(ws.root, ['checkout', '-q', 'other']);
    const result = await h.parking.acceptGitOperation(['a.txt'], 'git operation');
    expect(result).toEqual({ accepted: ['a.txt'], restored: [] });
    expect(await h.sweep()).toEqual([]);
    // The stash can no longer come back byte-for-byte over this baseline.
    expect(h.parking.parkedPaths).toEqual([]);
  });
});

describe('store helpers the round trip compares with', () => {
  it('hashes work-tree files to the ids the baseline stores, whatever .gitattributes says', async () => {
    const files: Record<string, string | Buffer> = {
      // An in-tree eol rule must not make the hash and the stored blob disagree (§5.4.1).
      '.gitattributes': '*.txt text eol=crlf\n',
      'crlf.txt': 'a\r\nb\r\n',
      'lf.txt': 'a\nb\n',
      'bin.dat': Buffer.from([0, 255, 1, 254, 10, 13]),
      'dir/with space ü.txt': 'x\n',
    };
    for (const [rel, content] of Object.entries(files)) await ws.file(rel, content);
    const { store } = await openStore();

    const paths = [...Object.keys(files), 'missing.txt'];
    const disk = await store.hashWorktreeFiles(paths);
    const baseline = await store.baselineEntries(paths);
    for (const rel of Object.keys(files)) {
      expect(disk.get(rel), rel).toBe(baseline.get(rel)?.oid);
    }
    expect(disk.get('missing.txt')).toBeNull();
    expect(baseline.has('missing.txt')).toBe(false);
  });

  it('setBaselineEntries moves the baseline without touching the work tree', async () => {
    await ws.file('a.txt', 'v1\n');
    const { store, walker } = await openStore();
    const v1 = (await store.baselineEntries(['a.txt'])).get('a.txt')!;

    await ws.file('a.txt', 'v2\n');
    await ws.file('b.txt', 'new\n');
    await store.commitPaths(['a.txt', 'b.txt'], 'accept');
    await store.setBaselineEntries(
      [
        { relPath: 'a.txt', entry: v1 },
        { relPath: 'b.txt', entry: null },
      ],
      'restore',
    );

    expect(await ws.readText('a.txt')).toBe('v2\n');
    expect(await ws.readText('b.txt')).toBe('new\n');
    expect((await store.readBaseline('a.txt'))?.toString()).toBe('v1\n');
    expect(await store.status(await walker.walk())).toEqual([
      { relPath: 'a.txt', status: 'M' },
      { relPath: 'b.txt', status: 'A' },
    ]);
  });
});
