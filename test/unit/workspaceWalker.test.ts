import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CONFIG, type LfctConfig } from '../../src/config';
import { IgnoreRules } from '../../src/scan/IgnoreRules';
import { WorkspaceWalker } from '../../src/scan/WorkspaceWalker';
import { makeTempWorkspace, type TempWorkspace } from '../helpers/tmp';

let ws: TempWorkspace;

function walker(overrides: Partial<LfctConfig> = {}): WorkspaceWalker {
  const rules = new IgnoreRules(ws.root, { ...DEFAULT_CONFIG, ...overrides }, ws.storage);
  return new WorkspaceWalker(ws.root, rules);
}

beforeEach(async () => {
  ws = await makeTempWorkspace('lfct-walk-');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await ws.cleanup();
});

describe('WorkspaceWalker', () => {
  it('enumerates source files and skips denylisted trees', async () => {
    await ws.file('src/app.ts', 'a');
    await ws.file('src/lib/util.ts', 'b');
    await ws.file('.env', 'SECRET=1');
    await ws.file('dist/app.js', 'built');
    await ws.file('node_modules/react/index.js', 'dep');
    await ws.file('.git/HEAD', 'ref: refs/heads/main');

    const files = await walker().walk();

    expect(files).toEqual(['.env', 'src/app.ts', 'src/lib/util.ts']);
  });

  it('never descends into a pruned directory', async () => {
    // The performance story from §5.5.1: node_modules must cost one comparison
    // and one readdir of its *parent*, not 60k stats. The directory count is
    // the direct evidence — if the walk descended, it would be far higher.
    await ws.file('src/app.ts', 'a');
    for (let i = 0; i < 20; i++) {
      await ws.file(`node_modules/pkg${i}/index.js`, 'dep');
    }
    await ws.file('dist/nested/deep/thing.js', 'built');

    const w = walker();
    const files = await w.walk();

    // Exactly two directories are ever read: the root and src/.
    expect(w.lastWalkStats.directories).toBe(2);
    expect(w.lastWalkStats.prunedDirectories).toBe(2); // node_modules, dist
    expect(files).toEqual(['src/app.ts']);
  });

  it('applies the size cap and reports what it skipped (E8)', async () => {
    await ws.file('small.txt', 'x'.repeat(100));
    await ws.file('huge.bin', Buffer.alloc(2 * 1024 * 1024, 1));

    const w = walker({ maxFileSizeMB: 1 });
    const files = await w.walk();

    expect(files).toEqual(['small.txt']);
    expect(w.lastWalkStats.oversized).toEqual([
      { relPath: 'huge.bin', size: 2 * 1024 * 1024 },
    ]);
  });

  it('lfct.include overrides the size cap', async () => {
    await ws.file('data/big.json', Buffer.alloc(2 * 1024 * 1024, 1));
    const files = await walker({ maxFileSizeMB: 1, include: ['data/**'] }).walk();
    expect(files).toEqual(['data/big.json']);
  });

  it('tracks a symlink but never follows it out of the work tree (E11)', async () => {
    await ws.file('src/real.ts', 'real');
    const outside = path.join(path.dirname(ws.root), 'outside');
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, 'secret.ts'), 'not ours');

    await fs.symlink(outside, ws.abs('linked-dir'));
    await fs.symlink(path.join(outside, 'secret.ts'), ws.abs('src/linked-file.ts'));

    const files = await walker().walk();

    // The links themselves are tracked; git stores them as links.
    expect(files).toContain('linked-dir');
    expect(files).toContain('src/linked-file.ts');
    // Nothing from beyond the work tree leaks in.
    expect(files.some((f) => f.includes('secret'))).toBe(false);
    expect(files).not.toContain('linked-dir/secret.ts');
  });

  it('skips a nested repository or submodule (E3)', async () => {
    await ws.file('src/app.ts', 'a');
    await ws.file('vendored/lib/.git/HEAD', 'ref: refs/heads/main');
    await ws.file('vendored/lib/index.js', 'nested');

    const w = walker();
    const files = await w.walk();

    expect(files).toEqual(['src/app.ts']);
    expect(w.lastWalkStats.nestedRepos).toEqual(['vendored/lib']);
  });

  it('notices an ambiguous directory that holds source (§17.1)', async () => {
    await ws.file('src/app.ts', 'a');
    await ws.file('bin/cli.ts', 'export {}');
    await ws.file('out/app.js', 'built');

    const w = walker();
    await w.walk();

    // bin/ holds a .ts file, out/ holds only build output.
    expect(w.lastWalkStats.ambiguousWithSource).toEqual(['bin']);
  });

  it('honors cancellation', async () => {
    for (let i = 0; i < 50; i++) await ws.file(`d${i}/f.ts`, 'x');
    const token = { isCancellationRequested: true };
    const w = walker();
    const files = await w.walk(token);
    expect(files).toEqual([]);
    expect(w.lastWalkStats.cancelled).toBe(true);
  });

  it('returns sorted, POSIX-separated, workspace-relative paths', async () => {
    await ws.file('z/b.ts', 'x');
    await ws.file('a/deep/nested/c.ts', 'x');
    await ws.file('a/b.ts', 'x');

    const files = await walker().walk();

    expect(files).toEqual(['a/b.ts', 'a/deep/nested/c.ts', 'z/b.ts']);
    expect(files.every((f) => !f.includes('\\'))).toBe(true);
    expect(files.every((f) => !path.isAbsolute(f))).toBe(true);
  });

  it('survives an unreadable directory without aborting the walk', async () => {
    await ws.file('src/app.ts', 'a');
    await ws.mkdir('locked');
    await fs.chmod(ws.abs('locked'), 0o000);
    try {
      const files = await walker().walk();
      expect(files).toContain('src/app.ts');
    } finally {
      await fs.chmod(ws.abs('locked'), 0o755);
    }
  });
});
