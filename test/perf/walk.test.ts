import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../../src/config';
import { reconcile } from '../../src/detect/reconcile';
import { createMemoryLogger } from '../../src/log';
import { IgnoreRules } from '../../src/scan/IgnoreRules';
import { WorkspaceWalker } from '../../src/scan/WorkspaceWalker';
import { CheckpointStore } from '../../src/store/CheckpointStore';
import { makeTempWorkspace, realGitVersion, type TempWorkspace } from '../helpers/tmp';

/**
 * §13.4 — the performance harness.
 *
 * The purpose is catching order-of-magnitude regressions, not defending exact
 * milliseconds, so the budgets below are the §9.1 numbers with generous
 * multipliers for shared CI runners.
 *
 * The property that actually matters is the one asserted first everywhere: the
 * denylist does essentially all the work. A tree with 500 source files and
 * 60,000 in node_modules must cost about the same as one with 500 files.
 */

let ws: TempWorkspace;
const log = createMemoryLogger();

/** CI runners are noisy and shared; scale the §9.1 budgets accordingly. */
const SLACK = process.env.CI ? 8 : 4;

beforeEach(async () => {
  ws = await makeTempWorkspace('lfct-perf-');
});

afterEach(async () => {
  await ws.cleanup();
});

/** Writes `count` files across `count / perDir` directories. */
async function generateTree(
  root: string,
  relRoot: string,
  count: number,
  perDir = 50,
): Promise<void> {
  const dirs = Math.ceil(count / perDir);
  for (let d = 0; d < dirs; d++) {
    const dir = path.join(root, relRoot, `pkg${d}`);
    await fs.mkdir(dir, { recursive: true });
    const writes: Promise<void>[] = [];
    for (let f = 0; f < perDir && d * perDir + f < count; f++) {
      writes.push(
        fs.writeFile(
          path.join(dir, `file${f}.ts`),
          `export const v${f} = ${f};\n// ${'x'.repeat(200)}\n`,
        ),
      );
    }
    await Promise.all(writes);
  }
}

function makeWalker(): WorkspaceWalker {
  const rules = new IgnoreRules(ws.root, DEFAULT_CONFIG, ws.storage);
  return new WorkspaceWalker(ws.root, rules, log);
}

describe('walk performance (§9.1)', () => {
  it('walks a 1k-file tree well inside budget', async () => {
    await generateTree(ws.root, 'src', 1000);
    const walker = makeWalker();

    await walker.walk(); // warm the page cache
    const started = Date.now();
    const files = await walker.walk();
    const elapsed = Date.now() - started;

    expect(files).toHaveLength(1000);
    expect(elapsed, `1k walk took ${elapsed}ms`).toBeLessThan(500 * SLACK);
  });

  it('walks a 10k-file tree inside budget', async () => {
    await generateTree(ws.root, 'src', 10_000);
    const walker = makeWalker();

    await walker.walk();
    const started = Date.now();
    const files = await walker.walk();
    const elapsed = Date.now() - started;

    expect(files).toHaveLength(10_000);
    // §5.5.2 budgets 50-200ms for a pruned 10k tree on an SSD.
    expect(elapsed, `10k walk took ${elapsed}ms`).toBeLessThan(1000 * SLACK);
  });

  it('the denylist does essentially all the work (§9.1)', async () => {
    // The headline claim: a typical Next.js app is ~500 source files and 60k+
    // in node_modules. With correct exclusions the second number must not
    // appear in the timings at all.
    await generateTree(ws.root, 'src', 500);
    await generateTree(ws.root, 'node_modules', 20_000);
    await generateTree(ws.root, 'dist', 5_000);

    const walker = makeWalker();
    await walker.walk();
    const started = Date.now();
    const files = await walker.walk();
    const elapsed = Date.now() - started;

    expect(files).toHaveLength(500);
    // 25,500 files exist; 500 are enumerated. The walk must cost like 500.
    expect(elapsed, `pruned walk took ${elapsed}ms`).toBeLessThan(500 * SLACK);
    expect(walker.lastWalkStats.prunedDirectories).toBeGreaterThan(0);
  });
});

describe('checkpoint performance (§9.1)', () => {
  it('builds a 1k baseline and reconciles incrementally', async () => {
    await generateTree(ws.root, 'src', 1000);
    const walker = makeWalker();
    const store = await CheckpointStore.open({
      storagePath: ws.storage,
      worktree: ws.root,
      version: await realGitVersion(),
      extensionVersion: '0.1.0-test',
      log,
    });

    const paths = await walker.walk();
    const baselineStart = Date.now();
    await store.createInitialBaseline(paths);
    const baselineMs = Date.now() - baselineStart;
    expect(baselineMs, `1k baseline took ${baselineMs}ms`).toBeLessThan(5_000 * SLACK);

    // Every later checkpoint consults git's index stat-cache and re-hashes only
    // what changed, which is the whole reason §5.2 chooses a shadow repo.
    await fs.writeFile(path.join(ws.root, 'src', 'pkg0', 'file0.ts'), 'changed\n');

    const reconcileStart = Date.now();
    const result = await reconcile(store, walker, log);
    const reconcileMs = Date.now() - reconcileStart;

    expect(result.statuses).toHaveLength(1);
    expect(reconcileMs, `1k reconcile took ${reconcileMs}ms`).toBeLessThan(2_000 * SLACK);

    const acceptStart = Date.now();
    await store.commitPaths(['src/pkg0/file0.ts'], 'accept');
    const acceptMs = Date.now() - acceptStart;
    // §9.1 budgets <100ms for an incremental checkpoint under 5k files.
    expect(acceptMs, `incremental accept took ${acceptMs}ms`).toBeLessThan(1_000 * SLACK);

    store.dispose();
  });

  it('P3 — a 100-file burst reconciles inside budget', async () => {
    await generateTree(ws.root, 'src', 2000);
    const walker = makeWalker();
    const store = await CheckpointStore.open({
      storagePath: ws.storage,
      worktree: ws.root,
      version: await realGitVersion(),
      extensionVersion: '0.1.0-test',
      log,
    });
    await store.createInitialBaseline(await walker.walk());

    const touched: string[] = [];
    for (let i = 0; i < 100; i++) {
      const rel = `src/pkg${Math.floor(i / 50)}/file${i % 50}.ts`;
      await fs.writeFile(path.join(ws.root, rel), `agent wrote ${i}\n`);
      touched.push(rel);
    }

    const started = Date.now();
    const result = await reconcile(store, walker, log);
    const elapsed = Date.now() - started;

    expect(result.statuses).toHaveLength(100);
    expect(elapsed, `100-file refresh took ${elapsed}ms`).toBeLessThan(500 * SLACK);

    store.dispose();
  });
});

describe('ignore-rule hot path (P2)', () => {
  it('classifies 50k paths in well under a millisecond each', async () => {
    // During an `npm install` the watcher can deliver tens of thousands of
    // events per second, and the extension host must not stall.
    const rules = new IgnoreRules(ws.root, DEFAULT_CONFIG, ws.storage);
    const paths = Array.from({ length: 50_000 }, (_, i) =>
      i % 2 === 0
        ? path.join(ws.root, `node_modules/pkg${i % 500}/lib/file${i}.js`)
        : path.join(ws.root, `src/module${i % 200}/file${i}.ts`),
    );

    const started = Date.now();
    let tracked = 0;
    for (const p of paths) if (rules.isTracked(p)) tracked++;
    const elapsed = Date.now() - started;

    expect(tracked).toBe(25_000);
    const perCall = elapsed / paths.length;
    expect(perCall, `${perCall.toFixed(4)}ms per isTracked call`).toBeLessThan(0.05);
  });
});
