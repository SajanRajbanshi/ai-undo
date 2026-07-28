import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, type LfctConfig } from '../../src/config';
import { reconcile } from '../../src/detect/reconcile';
import { acceptHunkIntoBaseline, computeHunks, revertHunk } from '../../src/diff/hunks';
import { createMemoryLogger } from '../../src/log';
import { IgnoreRules } from '../../src/scan/IgnoreRules';
import { WorkspaceWalker } from '../../src/scan/WorkspaceWalker';
import { CheckpointStore, type FileStatus } from '../../src/store/CheckpointStore';
import {
  ATTRIBUTES_CONTENT,
  SchemaMismatchError,
  SHADOW_DIR_NAME,
  WorktreeMismatchError,
} from '../../src/store/init';
import {
  git,
  initRealRepo,
  makeTempWorkspace,
  realGitVersion,
  type TempWorkspace,
} from '../helpers/tmp';

/**
 * §13.2 — real git against a real temp filesystem, no VS Code.
 *
 * The two highest-value tests in the whole suite live here: the `.gitignore`
 * override (the regression test for §5.5) and content passthrough (§5.4.1).
 * Both guard failure modes that are silent and destructive.
 */

let ws: TempWorkspace;
const log = createMemoryLogger();

beforeEach(async () => {
  ws = await makeTempWorkspace('lfct-store-');
});

afterEach(async () => {
  await ws.cleanup();
});

async function openStore(config: Partial<LfctConfig> = {}) {
  const version = await realGitVersion();
  const store = await CheckpointStore.open({
    storagePath: ws.storage,
    worktree: ws.root,
    version,
    extensionVersion: '0.1.0-test',
    log,
  });
  const rules = new IgnoreRules(ws.root, { ...DEFAULT_CONFIG, ...config }, ws.storage);
  const walker = new WorkspaceWalker(ws.root, rules, log);
  return { store, walker, rules };
}

async function baseline(config: Partial<LfctConfig> = {}) {
  const ctx = await openStore(config);
  const paths = await ctx.walker.walk();
  await ctx.store.createInitialBaseline(paths);
  return ctx;
}

function byPath(statuses: FileStatus[]): Record<string, string> {
  return Object.fromEntries(statuses.map((s) => [s.relPath, s.status]));
}

// ---------------------------------------------------------------------------

describe('initialization (§5.4)', () => {
  it('creates a non-bare repo with the right work tree and no .git in the project', async () => {
    const { store } = await openStore();
    const gitDir = path.join(ws.storage, SHADOW_DIR_NAME);

    expect(await fs.stat(gitDir)).toBeTruthy();
    // The store must sit outside the blast radius of the thing it undoes (§5.3).
    await expect(fs.stat(path.join(ws.root, '.git'))).rejects.toThrow();

    const config = await fs.readFile(path.join(gitDir, 'config'), 'utf8');
    expect(config).toContain('bare = false');
    expect(config).toContain(`worktree = ${ws.root}`);
    expect(store.hasBaseline()).toBe(false);
  });

  it('writes the attributes neutralization before anything is added (§5.4.1)', async () => {
    await openStore();
    const attributes = await fs.readFile(
      path.join(ws.storage, SHADOW_DIR_NAME, 'info', 'attributes'),
      'utf8',
    );
    expect(attributes).toBe(ATTRIBUTES_CONTENT);
  });

  it('recovers a stale index.lock (E6)', async () => {
    await openStore();
    const lockPath = path.join(ws.storage, SHADOW_DIR_NAME, 'index.lock');
    await fs.writeFile(lockPath, '');
    const old = Date.now() - 120_000;
    await fs.utimes(lockPath, old / 1000, old / 1000);

    const version = await realGitVersion();
    const store = await CheckpointStore.open({
      storagePath: ws.storage,
      worktree: ws.root,
      version,
      extensionVersion: '0.1.0-test',
      log,
    });

    expect(store.recoveredStaleLock).toBe(true);
    await expect(fs.stat(lockPath)).rejects.toThrow();
  });

  it('leaves a fresh index.lock alone', async () => {
    await openStore();
    const lockPath = path.join(ws.storage, SHADOW_DIR_NAME, 'index.lock');
    await fs.writeFile(lockPath, '');

    const version = await realGitVersion();
    const store = await CheckpointStore.open({
      storagePath: ws.storage,
      worktree: ws.root,
      version,
      extensionVersion: '0.1.0-test',
      log,
    });
    expect(store.recoveredStaleLock).toBe(false);
    await fs.rm(lockPath);
  });

  it('refuses a store belonging to another work tree (E4)', async () => {
    await openStore();
    const version = await realGitVersion();
    await expect(
      CheckpointStore.open({
        storagePath: ws.storage,
        worktree: path.join(ws.root, 'somewhere-else'),
        version,
        extensionVersion: '0.1.0-test',
        log,
      }),
    ).rejects.toBeInstanceOf(WorktreeMismatchError);
  });

  it('refuses a store from an incompatible schema (E21)', async () => {
    await openStore();
    const metaPath = path.join(ws.storage, 'meta.json');
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    meta.schemaVersion = 99;
    await fs.writeFile(metaPath, JSON.stringify(meta));

    const version = await realGitVersion();
    await expect(
      CheckpointStore.open({
        storagePath: ws.storage,
        worktree: ws.root,
        version,
        extensionVersion: '0.1.0-test',
        log,
      }),
    ).rejects.toBeInstanceOf(SchemaMismatchError);
  });
});

// ---------------------------------------------------------------------------

describe('environment isolation (§5.4, §S3)', () => {
  it('ignores an ambient GIT_INDEX_FILE and the user global config', async () => {
    // An agent or a shell profile can leave GIT_* variables in the environment.
    // Honoring GIT_INDEX_FILE would send our staging into someone else's index.
    const strayIndex = path.join(ws.storage, 'stray.index');
    const strayConfig = path.join(ws.storage, 'stray.gitconfig');
    await fs.writeFile(strayConfig, '[core]\n\tautocrlf = true\n[commit]\n\tgpgsign = true\n');

    const saved = { ...process.env };
    process.env.GIT_INDEX_FILE = strayIndex;
    process.env.GIT_CONFIG_GLOBAL = strayConfig;
    process.env.GIT_AUTHOR_NAME = '';
    process.env.GIT_AUTHOR_EMAIL = '';

    try {
      await ws.file('crlf.txt', Buffer.from('a\r\nb\r\n'));
      const { store } = await baseline();

      // The commit succeeded despite a global gpgsign and an empty identity.
      expect(store.hasBaseline()).toBe(true);
      // Our index was used, not the stray one.
      await expect(fs.stat(strayIndex)).rejects.toThrow();
      // And autocrlf=true did not rewrite the content.
      expect(Buffer.from((await store.readBaseline('crlf.txt'))!)).toEqual(
        Buffer.from('a\r\nb\r\n'),
      );
    } finally {
      process.env = saved;
    }
  });

  it('ignores GIT_LITERAL_PATHSPECS, which would break every pathspec we send', async () => {
    // With this set, git reads our `:(literal,top)` prefix as part of the
    // filename, so add and restore match nothing and fail silently.
    const saved = { ...process.env };
    process.env.GIT_LITERAL_PATHSPECS = '1';
    process.env.GIT_ICASE_PATHSPECS = '1';

    try {
      await ws.file('src/app.ts', 'original\n');
      const { store, walker } = await baseline();
      expect([...(await store.trackedPaths())]).toEqual(['src/app.ts']);

      await ws.file('src/app.ts', 'changed\n');
      const { statuses } = await reconcile(store, walker, log);
      expect(byPath(statuses)).toEqual({ 'src/app.ts': 'M' });

      await store.restore(['src/app.ts']);
      expect(await ws.readText('src/app.ts')).toBe('original\n');
    } finally {
      process.env = saved;
    }
  });
});

describe('the .gitignore override (§5.5) — highest-value regression test', () => {
  async function fixture() {
    await ws.file('.gitignore', '.env\n*.local\nconfig/\nnode_modules/\ndist/\n');
    await ws.file('.env', 'SECRET=original\n');
    await ws.file('src/app.ts', 'export const a = 1;\n');
    await ws.file('config/settings.json', '{"a":1}\n');
    await ws.file('node_modules/react/index.js', 'module.exports = {};\n');
    await ws.file('dist/bundle.js', 'built\n');
    return baseline();
  }

  it('force-adds gitignored files into the baseline (G6, S8)', async () => {
    const { store } = await fixture();
    const tracked = await store.trackedPaths();

    expect(tracked.has('.env')).toBe(true);
    expect(tracked.has('config/settings.json')).toBe(true);
    expect(tracked.has('src/app.ts')).toBe(true);
    // Excluded by *our* denylist, not by the project's .gitignore.
    expect([...tracked].some((p) => p.startsWith('node_modules/'))).toBe(false);
    expect([...tracked].some((p) => p.startsWith('dist/'))).toBe(false);
  });

  it('reports a modified .env as M and restores it verbatim', async () => {
    const { store, walker } = await fixture();
    await ws.file('.env', 'SECRET=rewritten-by-agent\n');

    const { statuses } = await reconcile(store, walker, log);
    expect(byPath(statuses)).toEqual({ '.env': 'M' });

    await store.restore(['.env']);
    expect(await ws.readText('.env')).toBe('SECRET=original\n');
  });

  it('reports a newly created ignored file as A', async () => {
    // This is the case no `git status --ignored` mode can give us, and the
    // reason §5.5.1 removes git from file selection entirely.
    const { store, walker } = await fixture();
    await ws.file('.env.local', 'LOCAL=1\n');

    const { statuses } = await reconcile(store, walker, log);
    expect(byPath(statuses)).toEqual({ '.env.local': 'A' });
  });

  it('reports a new file inside a wholly ignored directory as A', async () => {
    const { store, walker } = await fixture();
    await ws.file('config/local.json', '{"local":true}\n');

    const { statuses } = await reconcile(store, walker, log);
    expect(byPath(statuses)).toEqual({ 'config/local.json': 'A' });
  });

  it('a nested .gitignore in a subdirectory is equally inert', async () => {
    const { store, walker } = await baseline();
    await ws.file('src/.gitignore', 'generated.ts\n*.secret\n');
    await ws.file('src/generated.ts', 'export const g = 1;\n');
    await ws.file('src/api.secret', 'key\n');

    const { statuses } = await reconcile(store, walker, log);
    expect(byPath(statuses)).toMatchObject({
      'src/.gitignore': 'A',
      'src/generated.ts': 'A',
      'src/api.secret': 'A',
    });
  });

  it('info/exclude and core.excludesFile cannot resurrect an ignored path either', async () => {
    const { store, walker } = await fixture();
    await fs.writeFile(
      path.join(ws.storage, SHADOW_DIR_NAME, 'info', 'exclude'),
      'src/\n*.ts\n',
      'utf8',
    );
    await ws.file('src/new.ts', 'export const n = 1;\n');

    const { statuses } = await reconcile(store, walker, log);
    // We enumerate, not git, so an exclude rule changes nothing.
    expect(byPath(statuses)).toEqual({ 'src/new.ts': 'A' });
  });

  it('never enumerates node_modules even when the project does not ignore it', async () => {
    await ws.file('src/app.ts', 'x');
    for (let i = 0; i < 30; i++) {
      await ws.file(`node_modules/pkg${i}/index.js`, 'dep');
    }
    const { store, walker } = await baseline();
    const tracked = await store.trackedPaths();
    expect([...tracked]).toEqual(['src/app.ts']);
    expect(walker.lastWalkStats.directories).toBe(2);
  });
});

// ---------------------------------------------------------------------------

describe('content passthrough (§5.4.1) — second-highest-value test', () => {
  it('survives text=auto and a filter with byte-identical content (E17, E18)', async () => {
    // A clean/smudge filter is the catastrophic case: without the info/attributes
    // neutralization, `add` stores the filter's output and restore writes that
    // over the user's real file. This is exactly how Git LFS would destroy it.
    await ws.file(
      '.gitattributes',
      '* text=auto\n*.bin filter=lfs diff=lfs merge=lfs -text\n*.dat filter=mangle\n',
    );

    const mixed = Buffer.from('line1\r\nline2\nline3\r\n\r\nline5');
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('héllo\n')]);
    const binary = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x89, 0x50]);

    await ws.file('mixed.txt', mixed);
    await ws.file('bom.txt', withBom);
    await ws.file('blob.bin', binary);
    await ws.file('data.dat', Buffer.from('SHOULD NOT BE MANGLED\n'));

    const { store, walker } = await baseline();

    // Rewrite everything, then reject it all back.
    await ws.file('mixed.txt', Buffer.from('destroyed'));
    await ws.file('bom.txt', Buffer.from('destroyed'));
    await ws.file('blob.bin', Buffer.from('destroyed'));
    await ws.file('data.dat', Buffer.from('destroyed'));

    const { statuses } = await reconcile(store, walker, log);
    expect(statuses).toHaveLength(4);

    await store.restore(statuses.map((s) => s.relPath));

    expect(await ws.read('mixed.txt')).toEqual(mixed);
    expect(await ws.read('bom.txt')).toEqual(withBom);
    expect(await ws.read('blob.bin')).toEqual(binary);
    expect(await ws.read('data.dat')).toEqual(Buffer.from('SHOULD NOT BE MANGLED\n'));

    // And no LFS pointer was ever written into the object store.
    const stored = await store.readBaseline('blob.bin');
    expect(Buffer.from(stored!)).toEqual(binary);
    expect(Buffer.from(stored!).toString('utf8')).not.toContain('git-lfs');
  });

  it('round-trips CRLF, trailing-newline and empty-file variants exactly', async () => {
    const cases: [string, Buffer][] = [
      ['crlf.txt', Buffer.from('a\r\nb\r\n')],
      ['lf.txt', Buffer.from('a\nb\n')],
      ['no-trailing.txt', Buffer.from('a\nb')],
      ['empty.txt', Buffer.alloc(0)],
      ['just-newline.txt', Buffer.from('\n')],
      ['nul-inside.bin', Buffer.from([0x61, 0x00, 0x62])],
      ['unicode.txt', Buffer.from('日本語 🎉 café\n', 'utf8')],
    ];
    for (const [name, content] of cases) await ws.file(name, content);

    const { store } = await baseline();
    for (const [name] of cases) await ws.file(name, Buffer.from('clobbered'));
    await store.restore(cases.map(([name]) => name));

    for (const [name, content] of cases) {
      expect(await ws.read(name), `${name} must round-trip byte-identically`).toEqual(content);
    }
  });
});

// ---------------------------------------------------------------------------

describe('hooks never fire (§S3)', () => {
  it('a project pre-commit hook does not run during checkpointing', async () => {
    await initRealRepo(ws.root);
    const hookPath = path.join(ws.root, '.git', 'hooks', 'pre-commit');
    await fs.writeFile(
      hookPath,
      `#!/bin/sh\ntouch "${path.join(ws.root, 'HOOK_RAN')}"\nexit 0\n`,
      { mode: 0o755 },
    );

    await ws.file('src/app.ts', 'x');
    const { store, walker } = await baseline();
    await ws.file('src/app.ts', 'y');
    await store.commitPaths(['src/app.ts'], 'accept');
    await reconcile(store, walker, log);

    expect(await ws.exists('HOOK_RAN')).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('status and restore semantics (§4.2)', () => {
  it('classifies M, A and D correctly', async () => {
    await ws.file('mod.ts', 'original\n');
    await ws.file('gone.ts', 'will be deleted\n');
    const { store, walker } = await baseline();

    await ws.file('mod.ts', 'changed\n');
    await ws.remove('gone.ts');
    await ws.file('new.ts', 'created\n');

    const { statuses } = await reconcile(store, walker, log);
    expect(byPath(statuses)).toEqual({ 'mod.ts': 'M', 'gone.ts': 'D', 'new.ts': 'A' });
  });

  it('S6 — rejecting an added file deletes it and prunes the empty directory', async () => {
    await ws.file('src/app.ts', 'x');
    const { store, walker } = await baseline();
    await ws.file('src/deep/nested/generated.ts', 'generated\n');

    const outcome = await store.restore(['src/deep/nested/generated.ts']);

    expect(await ws.exists('src/deep/nested/generated.ts')).toBe(false);
    expect(await ws.exists('src/deep')).toBe(false);
    expect(await ws.exists('src/app.ts')).toBe(true);
    expect(outcome.prunedDirs.length).toBe(2);

    const { statuses } = await reconcile(store, walker, log);
    expect(statuses).toHaveLength(0);
  });

  it('S7 — rejecting a deleted file recreates it with exact baseline bytes', async () => {
    const content = Buffer.from('#!/bin/sh\necho hi\n');
    await ws.file('script.sh', content);
    const { store } = await baseline();

    await ws.remove('script.sh');
    await store.restore(['script.sh']);

    expect(await ws.read('script.sh')).toEqual(content);
  });

  it('S3 — Accept advances the baseline and never touches disk', async () => {
    await ws.file('app.ts', 'original\n');
    const { store, walker } = await baseline();

    await ws.file('app.ts', 'agent version\n');
    const before = await ws.read('app.ts');
    await store.commitPaths(['app.ts'], 'accept');
    const after = await ws.read('app.ts');

    // The whole asymmetry of §1.1: Accept is bookkeeping only.
    expect(after).toEqual(before);
    const { statuses } = await reconcile(store, walker, log);
    expect(statuses).toHaveLength(0);
  });

  it('accepting a deletion removes the path from the baseline', async () => {
    await ws.file('gone.ts', 'x');
    await ws.file('stay.ts', 'y');
    const { store, walker } = await baseline();

    await ws.remove('gone.ts');
    await store.commitPaths(['gone.ts'], 'accept');

    const { statuses } = await reconcile(store, walker, log);
    expect(statuses).toHaveLength(0);
    expect((await store.trackedPaths()).has('gone.ts')).toBe(false);
  });

  it('accepting a path that vanished before the commit is a no-op, not a crash', async () => {
    await ws.file('a.ts', 'x');
    const { store } = await baseline();
    await expect(store.commitPaths(['never-existed.ts'], 'accept')).resolves.toBeUndefined();
  });

  it('E13 — a per-file restore failure is reported without losing the batch', async () => {
    await ws.file('ok.ts', 'original\n');
    await ws.file('locked/file.ts', 'original\n');
    const { store } = await baseline();

    await ws.file('ok.ts', 'changed\n');
    await ws.file('locked/file.ts', 'changed\n');
    await fs.chmod(ws.abs('locked'), 0o500);

    try {
      const outcome = await store.restore(['ok.ts', 'locked/file.ts']);
      expect(outcome.restored).toContain('ok.ts');
      expect(await ws.readText('ok.ts')).toBe('original\n');
      // Whether the locked write fails is platform-dependent; what matters is
      // that the other path still got restored and nothing threw.
      expect(outcome.restored.length + outcome.failures.length).toBe(2);
    } finally {
      await fs.chmod(ws.abs('locked'), 0o755);
    }
  });

  it('E15 — very long paths survive the NUL-separated stdin route', async () => {
    const deep = Array.from({ length: 12 }, (_, i) => `directory-with-a-long-name-${i}`).join('/');
    const relPath = `${deep}/file.ts`;
    expect(relPath.length).toBeGreaterThan(255);

    await ws.file(relPath, 'original\n');
    const { store, walker } = await baseline();
    await ws.file(relPath, 'changed\n');

    const { statuses } = await reconcile(store, walker, log);
    expect(byPath(statuses)).toEqual({ [relPath]: 'M' });
    await store.restore([relPath]);
    expect(await ws.readText(relPath)).toBe('original\n');
  });

  it('handles paths with glob characters, spaces and quotes', async () => {
    const names = ['weird [1].ts', "it's a file.ts", 'star*name.ts', 'ünïcodé 日本.ts'];
    for (const n of names) await ws.file(`src/${n}`, 'original\n');

    const { store, walker } = await baseline();
    for (const n of names) await ws.file(`src/${n}`, 'changed\n');

    const { statuses } = await reconcile(store, walker, log);
    expect(statuses).toHaveLength(names.length);

    await store.restore(statuses.map((s) => s.relPath));
    for (const n of names) {
      expect(await ws.readText(`src/${n}`)).toBe('original\n');
    }
  });
});

// ---------------------------------------------------------------------------

describe('per-hunk Accept (commitContent)', () => {
  it('advances the baseline to synthesized content without touching disk', async () => {
    const baselineText = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n';
    await ws.file('a.ts', baselineText);
    const { store, walker } = await baseline();

    // Two distant changes, i.e. two hunks.
    const currentText = baselineText
      .replace('line 2\n', 'CHANGED 2\n')
      .replace('line 35\n', 'CHANGED 35\n');
    await ws.file('a.ts', currentText);

    const hunks = computeHunks(baselineText, currentText);
    expect(hunks).toHaveLength(2);

    const onDiskBefore = await ws.read('a.ts');
    const advanced = acceptHunkIntoBaseline(baselineText, hunks[0]);
    await store.commitContent('a.ts', advanced, 'accept hunk');

    // Accept never writes to the work tree, per-hunk included (§1.1).
    expect(await ws.read('a.ts')).toEqual(onDiskBefore);

    // The baseline moved by exactly one hunk.
    const newBaseline = Buffer.from((await store.readBaseline('a.ts'))!).toString('utf8');
    expect(newBaseline).toBe(advanced);
    expect(newBaseline).toContain('CHANGED 2');
    expect(newBaseline).not.toContain('CHANGED 35');

    // The file is still pending, because the second hunk remains.
    const { statuses } = await reconcile(store, walker, log);
    expect(byPath(statuses)).toEqual({ 'a.ts': 'M' });

    // Accepting the remaining hunk clears it entirely.
    const remaining = computeHunks(newBaseline, currentText);
    expect(remaining).toHaveLength(1);
    await store.commitContent('a.ts', acceptHunkIntoBaseline(newBaseline, remaining[0]), 'accept');
    expect((await reconcile(store, walker, log)).statuses).toHaveLength(0);
  });

  it('preserves the executable bit', async () => {
    await ws.file('run.sh', '#!/bin/sh\necho one\n');
    await fs.chmod(ws.abs('run.sh'), 0o755);
    const { store } = await baseline();

    expect(await store.readBaseline('run.sh')).not.toBeNull();
    await store.commitContent('run.sh', '#!/bin/sh\necho two\n', 'accept hunk');

    // Losing the executable bit in the baseline would silently break the
    // script the next time it was restored.
    const staged = await store.trackedPaths();
    expect(staged.has('run.sh')).toBe(true);

    await ws.file('run.sh', 'clobbered');
    await store.restore(['run.sh']);
    const st = await fs.stat(ws.abs('run.sh'));
    expect(st.mode & 0o111).toBeGreaterThan(0);
    expect(await ws.readText('run.sh')).toBe('#!/bin/sh\necho two\n');
  });
});

describe('folder rename (S12, §6.9)', () => {
  it('resolves to N deletes plus N adds and reverses cleanly', async () => {
    const count = 25;
    for (let i = 0; i < count; i++) {
      await ws.file(`src/mod${i}.ts`, `export const m${i} = ${i};\n`);
    }
    const { store, walker } = await baseline();

    await fs.rename(ws.abs('src'), ws.abs('lib'));

    const { statuses } = await reconcile(store, walker, log);
    const deleted = statuses.filter((s) => s.status === 'D');
    const added = statuses.filter((s) => s.status === 'A');
    expect(deleted).toHaveLength(count);
    expect(added).toHaveLength(count);

    await store.restore(statuses.map((s) => s.relPath));

    // Original tree restored, copies gone, and no empty husk left behind.
    for (let i = 0; i < count; i++) {
      expect(await ws.readText(`src/mod${i}.ts`)).toBe(`export const m${i} = ${i};\n`);
    }
    expect(await ws.exists('lib')).toBe(false);

    const after = await reconcile(store, walker, log);
    expect(after.statuses).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe('patches (§7.5.1)', () => {
  it('produces a unified patch for a modified file', async () => {
    await ws.file('a.ts', 'one\ntwo\nthree\n');
    const { store } = await baseline();
    await ws.file('a.ts', 'one\nTWO\nthree\n');

    const patch = await store.readPatch('a.ts', 'M');
    expect(patch).toContain('--- a/a.ts');
    expect(patch).toContain('+++ b/a.ts');
    expect(patch).toContain('-two');
    expect(patch).toContain('+TWO');
  });

  it('produces an all-additions patch for a created file', async () => {
    await ws.file('keep.ts', 'x');
    const { store } = await baseline();
    await ws.file('new.ts', 'alpha\nbeta\n');

    const patch = await store.readPatch('new.ts', 'A');
    expect(patch).toContain('new file mode');
    expect(patch).toContain('@@ -0,0 +1,2 @@');
    expect(patch).toContain('+alpha');
  });

  it('produces an all-deletions patch for a removed file', async () => {
    await ws.file('gone.ts', 'alpha\nbeta\n');
    const { store } = await baseline();
    await ws.remove('gone.ts');

    const patch = await store.readPatch('gone.ts', 'D');
    expect(patch).toContain('-alpha');
    expect(patch).toContain('-beta');
  });

  it('still produces a textual patch when the project sets diff drivers (§5.4.1)', async () => {
    // Regression guard: unsetting `diff` in info/attributes (rather than making
    // it unspecified) makes git call every file binary, which turns the entire
    // inline diff surface into "Binary files ... differ". Silent and total.
    await ws.file('.gitattributes', '* text=auto diff=lfs\n*.ts diff=astextplain\n');
    await ws.file('a.ts', 'one\ntwo\nthree\n');
    const { store } = await baseline();
    await ws.file('a.ts', 'one\nTWO\nthree\n');

    const patch = await store.readPatch('a.ts', 'M');
    expect(patch).not.toContain('Binary files');
    expect(patch).toContain('-two');
    expect(patch).toContain('+TWO');
  });

  it('still reports genuinely binary content as binary', async () => {
    await ws.file('blob.bin', Buffer.from([0x00, 0x01, 0x02, 0x03]));
    const { store } = await baseline();
    await ws.file('blob.bin', Buffer.from([0x00, 0x09, 0x08, 0x07]));

    const patch = await store.readPatch('blob.bin', 'M');
    expect(patch).toContain('Binary files');
  });

  it('readBaseline returns null for a path absent from HEAD', async () => {
    await ws.file('a.ts', 'x');
    const { store } = await baseline();
    expect(await store.readBaseline('a.ts')).not.toBeNull();
    expect(await store.readBaseline('never-existed.ts')).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('rebuild and gc', () => {
  it('rebuild adopts the current disk contents as the new baseline', async () => {
    await ws.file('a.ts', 'original\n');
    const { store, walker } = await baseline();
    await ws.file('a.ts', 'changed\n');
    await ws.file('b.ts', 'new\n');

    expect((await reconcile(store, walker, log)).statuses).toHaveLength(2);

    await store.rebuild(await walker.walk());

    expect((await reconcile(store, walker, log)).statuses).toHaveLength(0);
    expect(Buffer.from((await store.readBaseline('a.ts'))!).toString()).toBe('changed\n');
  });

  it('gc completes without disturbing the baseline', async () => {
    await ws.file('a.ts', 'x');
    const { store, walker } = await baseline();
    await store.gc();
    expect((await reconcile(store, walker, log)).statuses).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe('serialization (§7.1)', () => {
  it('concurrent commits do not corrupt the index', async () => {
    for (let i = 0; i < 10; i++) await ws.file(`f${i}.ts`, 'original\n');
    const { store, walker } = await baseline();
    for (let i = 0; i < 10; i++) await ws.file(`f${i}.ts`, `changed ${i}\n`);

    // Fired without awaiting between them: the promise queue in git.ts is the
    // only thing preventing an index.lock collision here.
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.commitPaths([`f${i}.ts`], `accept ${i}`)),
    );

    expect((await reconcile(store, walker, log)).statuses).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe('nested repositories (E3)', () => {
  it('excludes a nested repo from the baseline entirely', async () => {
    await ws.file('src/app.ts', 'x');
    await ws.file('vendor-lib/index.js', 'y');
    await initRealRepo(ws.abs('vendor-lib'));
    await git(ws.abs('vendor-lib'), ['add', '-A']);
    await git(ws.abs('vendor-lib'), ['commit', '-q', '-m', 'init']);

    const { store, walker } = await baseline();
    const tracked = await store.trackedPaths();

    expect([...tracked]).toEqual(['src/app.ts']);
    expect(walker.lastWalkStats.nestedRepos).toEqual(['vendor-lib']);
  });
});

describe('accepting hunks one at a time clears the file (§16)', () => {
  /**
   * The bug this pins down: each Accept moves the baseline, so the next one has
   * to be computed against the *new* baseline. Accepting a second hunk off a
   * snapshot taken before the first would write a baseline that never contained
   * the first, and the file would never leave the pending list no matter how
   * many times the user clicked Keep.
   */
  it('converges when every hunk is recomputed against the live baseline', async () => {
    const baselineText = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n';
    await ws.file('a.ts', baselineText);
    const { store, walker } = await baseline();

    // Additions, deletions and modifications interleaved — the deletions are
    // the ones that used to have no controls at all.
    const currentText =
      Array.from({ length: 30 }, (_, i) => `line ${i}`)
        .filter((_, i) => i !== 5 && i !== 6 && i !== 21)
        .flatMap((l, i) => (i === 2 ? [l, 'INSERTED A', 'INSERTED B'] : [l]))
        .map((l) => (l === 'line 14' ? 'CHANGED 14' : l))
        .join('\n') + '\n';
    await ws.file('a.ts', currentText);

    expect(computeHunks(baselineText, currentText).length).toBeGreaterThan(3);

    // One Accept per click, each against whatever the baseline is right now.
    let clicks = 0;
    for (;;) {
      const live = Buffer.from((await store.readBaseline('a.ts'))!).toString('utf8');
      const hunks = computeHunks(live, currentText);
      if (hunks.length === 0) break;
      expect(clicks++).toBeLessThan(20);
      await store.commitContent('a.ts', acceptHunkIntoBaseline(live, hunks[0]), 'accept hunk');
    }

    expect(clicks).toBeGreaterThan(3);
    // Accept never writes to disk, per-hunk included.
    expect(await ws.readText('a.ts')).toBe(currentText);
    // And the file is gone from the pending list.
    expect((await reconcile(store, walker, log)).statuses).toHaveLength(0);
  });

  it('reverting hunk by hunk lands back on the baseline exactly', async () => {
    const baselineText = 'a\nb\nc\nd\ne\nf\ng\nh\n';
    await ws.file('a.ts', baselineText);
    const { store, walker } = await baseline();

    const currentText = 'a\nB\nc\nNEW\nd\nf\ng\nH\n';
    await ws.file('a.ts', currentText);

    // Reject applies to the file, so each pass re-reads what is on disk.
    for (;;) {
      const onDisk = await ws.readText('a.ts');
      const hunks = computeHunks(baselineText, onDisk);
      if (hunks.length === 0) break;
      await ws.file('a.ts', revertHunk(onDisk, hunks[0]));
    }

    expect(await ws.readText('a.ts')).toBe(baselineText);
    expect((await reconcile(store, walker, log)).statuses).toHaveLength(0);
  });
});
