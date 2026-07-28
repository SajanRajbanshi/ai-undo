import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, resolveConfig, trackedSetChanged } from '../../src/config';
import { GitMarkerTracker } from '../../src/detect/GitOpMonitor';
import { parseNameStatusZ } from '../../src/store/CheckpointStore';
import { parseGitVersion, pathspecStdin, versionAtLeast } from '../../src/store/git';
import { binaryPlaceholder, isBinary, makeAddedFilePatch } from '../../src/store/patch';
import { Emitter } from '../../src/util/emitter';
import { basename, dirnamePosix, isInside, pathKey, toRelPosix } from '../../src/util/paths';
import { pruneEmptyParents } from '../../src/util/pruneEmptyDirs';
import { makeTempWorkspace, type TempWorkspace } from '../helpers/tmp';

describe('config', () => {
  it('fills defaults and clamps nonsense values', () => {
    const c = resolveConfig({ burstQuietMs: -5, maxFileSizeMB: 0, reconcileIntervalMs: 0 });
    expect(c.burstQuietMs).toBe(50);
    expect(c.maxFileSizeMB).toBe(0.001);
    // 0 is a documented value meaning "disabled", so it must survive.
    expect(c.reconcileIntervalMs).toBe(0);
    expect(c.notification).toBe('toast');
  });

  it('detects tracked-set-invalidating changes only (§11)', () => {
    const base = resolveConfig({});
    expect(trackedSetChanged(base, resolveConfig({ exclude: ['x'] }))).toBe(true);
    expect(trackedSetChanged(base, resolveConfig({ include: ['bin'] }))).toBe(true);
    expect(trackedSetChanged(base, resolveConfig({ maxFileSizeMB: 10 }))).toBe(true);
    expect(trackedSetChanged(base, resolveConfig({ notification: 'none' }))).toBe(false);
    expect(trackedSetChanged(base, resolveConfig({ diffView: 'sideBySide' }))).toBe(false);
  });

  it('does not share array references with the default config', () => {
    const c = resolveConfig({});
    c.exclude.push('mutated');
    expect(DEFAULT_CONFIG.exclude).toEqual([]);
  });
});

describe('paths', () => {
  it('returns undefined for paths outside the root', () => {
    const root = path.resolve('/ws');
    expect(toRelPosix(root, path.resolve('/ws/src/a.ts'))).toBe('src/a.ts');
    expect(toRelPosix(root, path.resolve('/other/a.ts'))).toBeUndefined();
    expect(toRelPosix(root, root)).toBeUndefined();
  });

  it('isInside includes the directory itself', () => {
    expect(isInside('/a', '/a')).toBe(true);
    expect(isInside('/a', '/a/b')).toBe(true);
    expect(isInside('/a', '/ab')).toBe(false);
  });

  it('pathKey normalizes consistently for the platform', () => {
    const a = pathKey(path.resolve('/ws/App.ts'));
    const b = pathKey(path.resolve('/ws/app.ts'));
    if (process.platform === 'darwin' || process.platform === 'win32') {
      expect(a).toBe(b);
    } else {
      expect(a).not.toBe(b);
    }
  });

  it('basename and dirnamePosix handle root-level paths', () => {
    expect(basename('a.ts')).toBe('a.ts');
    expect(dirnamePosix('a.ts')).toBe('');
    expect(basename('src/lib/a.ts')).toBe('a.ts');
    expect(dirnamePosix('src/lib/a.ts')).toBe('src/lib');
  });
});

describe('git helpers', () => {
  it('parses versions', () => {
    expect(parseGitVersion('git version 2.50.1 (Apple Git-155)')).toMatchObject({
      major: 2,
      minor: 50,
      patch: 1,
    });
    expect(parseGitVersion('git version 2.39')).toMatchObject({ major: 2, minor: 39, patch: 0 });
    expect(parseGitVersion('not git')).toBeUndefined();
  });

  it('compares versions', () => {
    const v = parseGitVersion('git version 2.30.0')!;
    expect(versionAtLeast(v, [2, 26])).toBe(true);
    expect(versionAtLeast(v, [2, 32])).toBe(false);
    expect(versionAtLeast(v, [3, 0])).toBe(false);
  });

  it('builds NUL-separated literal pathspecs (§5.5.1)', () => {
    // Literal magic is what keeps a file genuinely named `*.ts` from being
    // reinterpreted as a glob.
    const payload = pathspecStdin(['src/a.ts', '*weird[1].ts']).toString('utf8');
    expect(payload.split('\0')).toEqual([':(literal,top)src/a.ts', ':(literal,top)*weird[1].ts']);
  });
});

describe('parseNameStatusZ', () => {
  it('parses modified and deleted records', () => {
    expect(parseNameStatusZ('M\0src/a.ts\0D\0src/b.ts\0')).toEqual([
      { relPath: 'src/a.ts', status: 'M' },
      { relPath: 'src/b.ts', status: 'D' },
    ]);
  });

  it('maps a type change to modified', () => {
    expect(parseNameStatusZ('T\0src/link\0')).toEqual([{ relPath: 'src/link', status: 'M' }]);
  });

  it('handles empty output and paths containing spaces', () => {
    expect(parseNameStatusZ('')).toEqual([]);
    expect(parseNameStatusZ('M\0my dir/a b.ts\0')).toEqual([
      { relPath: 'my dir/a b.ts', status: 'M' },
    ]);
  });
});

describe('patch generation', () => {
  it('detects binary content by a NUL byte', () => {
    expect(isBinary(Buffer.from('hello world'))).toBe(false);
    expect(isBinary(Buffer.from([0x68, 0x00, 0x69]))).toBe(true);
    expect(isBinary(Buffer.alloc(0))).toBe(false);
  });

  it('renders an added file as all-additions', () => {
    const patch = makeAddedFilePatch('src/a.ts', Buffer.from('one\ntwo\n'));
    expect(patch).toBe(
      'diff --git a/src/a.ts b/src/a.ts\n' +
        'new file mode 100644\n' +
        '--- /dev/null\n' +
        '+++ b/src/a.ts\n' +
        '@@ -0,0 +1,2 @@\n' +
        '+one\n' +
        '+two\n',
    );
  });

  it('marks a missing trailing newline the way git does', () => {
    const patch = makeAddedFilePatch('a.txt', Buffer.from('one\ntwo'));
    expect(patch).toContain('@@ -0,0 +1,2 @@\n+one\n+two\n\\ No newline at end of file\n');
  });

  it('handles an empty added file', () => {
    const patch = makeAddedFilePatch('empty.txt', Buffer.alloc(0));
    expect(patch).toContain('--- /dev/null');
    expect(patch).not.toContain('@@');
  });

  it('reports a binary added file rather than emitting mojibake', () => {
    const patch = makeAddedFilePatch('logo.png', Buffer.from([0x89, 0x50, 0x00, 0x01]));
    expect(patch).toContain('Binary files /dev/null and b/logo.png differ');
  });

  it('binaryPlaceholder states both sizes', () => {
    const text = binaryPlaceholder('logo.png', 1024, 2048);
    expect(text).toContain('1.0 KB');
    expect(text).toContain('2.0 KB');
    expect(text).toContain('Accept and Reject still work');
  });
});

describe('GitMarkerTracker (§6.8)', () => {
  it('answers window queries inclusively at both edges', () => {
    const t = new GitMarkerTracker();
    t.setActive(true);
    t.record('HEAD', 1000);
    expect(t.movedWithin(1000, 1000)).toBe(true);
    expect(t.movedWithin(900, 1100)).toBe(true);
    expect(t.movedWithin(1001, 2000)).toBe(false);
    expect(t.movedWithin(0, 999)).toBe(false);
  });

  it('starts inactive so a non-repo workspace never classifies as git', () => {
    expect(new GitMarkerTracker().active).toBe(false);
  });
});

describe('Emitter', () => {
  it('delivers to every listener and honors disposal', () => {
    const emitter = new Emitter<number>();
    const seen: number[] = [];
    const a = emitter.event((v) => seen.push(v));
    emitter.event((v) => seen.push(v * 10));
    emitter.fire(1);
    a.dispose();
    emitter.fire(2);
    expect(seen).toEqual([1, 10, 20]);
  });

  it('tolerates a listener disposing itself during a fire', () => {
    const emitter = new Emitter<void>();
    let count = 0;
    const sub = emitter.event(() => {
      count++;
      sub.dispose();
    });
    emitter.fire();
    emitter.fire();
    expect(count).toBe(1);
  });
});

describe('pruneEmptyParents (§6.9, E10d)', () => {
  let ws: TempWorkspace;
  beforeEach(async () => {
    ws = await makeTempWorkspace('lfct-prune-');
  });
  afterEach(async () => {
    await ws.cleanup();
  });

  it('removes a chain of directories left empty', async () => {
    await ws.file('lib/a/b/c/file.ts', 'x');
    await fs.rm(ws.abs('lib/a/b/c/file.ts'));

    const removed = await pruneEmptyParents(ws.root, [ws.abs('lib/a/b/c/file.ts')]);

    expect(await ws.exists('lib')).toBe(false);
    expect(removed).toHaveLength(4);
  });

  it('stops at a directory that still holds something', async () => {
    await ws.file('lib/keep.ts', 'x');
    await ws.file('lib/gone/file.ts', 'x');
    await fs.rm(ws.abs('lib/gone/file.ts'));

    await pruneEmptyParents(ws.root, [ws.abs('lib/gone/file.ts')]);

    expect(await ws.exists('lib/gone')).toBe(false);
    expect(await ws.exists('lib/keep.ts')).toBe(true);
  });

  /**
   * The husk case. Walking up from `lib/a` reaches `lib` while `lib/b` still
   * exists, so it stops there — and must not poison `lib` for the later walk
   * from `lib/b`, which is the one that finds it empty.
   */
  it('removes a shared parent once its last child is pruned', async () => {
    await ws.file('lib/a/x.ts', 'x');
    await ws.file('lib/b/y.ts', 'x');
    const deleted = [ws.abs('lib/a/x.ts'), ws.abs('lib/b/y.ts')];
    for (const f of deleted) await fs.rm(f);

    const removed = await pruneEmptyParents(ws.root, deleted);

    expect(await ws.exists('lib/a')).toBe(false);
    expect(await ws.exists('lib/b')).toBe(false);
    expect(await ws.exists('lib')).toBe(false);
    expect(removed).toHaveLength(3);
  });

  it('removes a shared parent with three children', async () => {
    const deleted: string[] = [];
    for (const name of ['a', 'b', 'c']) {
      await ws.file(`pkg/${name}/f.ts`, 'x');
      deleted.push(ws.abs(`pkg/${name}/f.ts`));
    }
    for (const f of deleted) await fs.rm(f);

    await pruneEmptyParents(ws.root, deleted);

    expect(await ws.exists('pkg')).toBe(false);
  });

  it('keeps a shared parent that still holds an untouched file', async () => {
    await ws.file('lib/a/x.ts', 'x');
    await ws.file('lib/b/y.ts', 'x');
    await ws.file('lib/keep.ts', 'x');
    const deleted = [ws.abs('lib/a/x.ts'), ws.abs('lib/b/y.ts')];
    for (const f of deleted) await fs.rm(f);

    await pruneEmptyParents(ws.root, deleted);

    expect(await ws.exists('lib/a')).toBe(false);
    expect(await ws.exists('lib/b')).toBe(false);
    expect(await ws.exists('lib/keep.ts')).toBe(true);
  });

  it('never removes the workspace root', async () => {
    await ws.file('only.ts', 'x');
    await fs.rm(ws.abs('only.ts'));
    await pruneEmptyParents(ws.root, [ws.abs('only.ts')]);
    expect(await fs.stat(ws.root)).toBeTruthy();
  });

  it('never steps outside the workspace root', async () => {
    const sibling = path.join(path.dirname(ws.root), 'sibling');
    await fs.mkdir(sibling, { recursive: true });
    await pruneEmptyParents(ws.root, [path.join(sibling, 'file.ts')]);
    expect(await fs.stat(sibling)).toBeTruthy();
  });
});
