import { describe, expect, it } from 'vitest';
import * as path from 'node:path';

import { DEFAULT_CONFIG, type LfctConfig } from '../../src/config';
import { IgnoreRules, staticPrefix } from '../../src/scan/IgnoreRules';

const ROOT = path.resolve('/tmp/lfct-fixture');

function rules(overrides: Partial<LfctConfig> = {}, storagePath?: string): IgnoreRules {
  return new IgnoreRules(ROOT, { ...DEFAULT_CONFIG, ...overrides }, storagePath);
}

describe('IgnoreRules — L1 universal', () => {
  it('never tracks .git or node_modules, at any depth', () => {
    const r = rules();
    expect(r.isTrackedRel('.git/config')).toBe(false);
    expect(r.isTrackedRel('node_modules/react/index.js')).toBe(false);
    expect(r.isTrackedRel('packages/app/node_modules/x/y.js')).toBe(false);
    expect(r.shouldPruneDirRel('node_modules')).toBe(true);
    expect(r.shouldPruneDirRel('packages/app/node_modules')).toBe(true);
  });

  it('drops OS junk files', () => {
    const r = rules();
    expect(r.isTrackedRel('.DS_Store')).toBe(false);
    expect(r.isTrackedRel('src/.DS_Store')).toBe(false);
    expect(r.isTrackedRel('Thumbs.db')).toBe(false);
  });

  it('L1 cannot be overridden by lfct.include', () => {
    const r = rules({ include: ['node_modules', '.git', 'node_modules/**'] });
    expect(r.isTrackedRel('node_modules/react/index.js')).toBe(false);
    expect(r.shouldPruneDirRel('node_modules')).toBe(true);
    expect(r.isTrackedRel('.git/HEAD')).toBe(false);
  });

  it('never tracks the extension storage directory', () => {
    const storage = path.join(ROOT, '.storage');
    const r = rules({}, storage);
    expect(r.isTracked(path.join(storage, 'shadow.git', 'index'))).toBe(false);
    expect(r.shouldPruneDir(path.join(storage, 'shadow.git'))).toBe(true);
  });
});

describe('IgnoreRules — L2 ecosystem directories', () => {
  const cases: [string, boolean][] = [
    ['src/app.ts', true],
    ['dist/app.js', false],
    ['build/main.o', false],
    ['.next/server/page.js', false],
    ['coverage/lcov.info', false],
    ['__pycache__/mod.cpython-311.pyc', false],
    ['.venv/lib/python3.11/site-packages/x.py', false],
    ['.mypy_cache/3.11/x.json', false],
    ['target/debug/app', false],
    ['bin/tool', false],
    ['obj/Debug/app.dll', false],
    ['vendor/github.com/pkg/errors/x.go', false],
    ['Pods/Alamofire/Source/x.swift', false],
    ['.terraform/providers/x', false],
    ['.idea/workspace.xml', false],
    ['deep/nested/dist/chunk.js', false],
    ['src/lib/util.ts', true],
  ];

  for (const [relPath, expected] of cases) {
    it(`${expected ? 'tracks' : 'excludes'} ${relPath}`, () => {
      expect(rules().isTrackedRel(relPath)).toBe(expected);
    });
  }

  it('excludes file globs by basename', () => {
    const r = rules();
    expect(r.isTrackedRel('src/mod.pyc')).toBe(false);
    expect(r.isTrackedRel('src/.app.ts.swp')).toBe(false);
    expect(r.isTrackedRel('src/app.ts~')).toBe(false);
    expect(r.isTrackedRel('src/app.ts')).toBe(true);
  });

  it('excludes path globs such as *.egg-info', () => {
    const r = rules();
    expect(r.isTrackedRel('mypkg.egg-info/PKG-INFO')).toBe(false);
    expect(r.isTrackedRel('App.xcworkspace/xcuserdata/me.xcuserdatad/x')).toBe(false);
  });
});

describe('IgnoreRules — gitignored-but-important files (G6)', () => {
  // The whole point of §5.5: our denylist is independent of the project's
  // .gitignore, so these are tracked no matter what the project ignores.
  it('tracks .env and other local state', () => {
    const r = rules();
    expect(r.isTrackedRel('.env')).toBe(true);
    expect(r.isTrackedRel('.env.local')).toBe(true);
    expect(r.isTrackedRel('.env.production')).toBe(true);
    expect(r.isTrackedRel('config/local.json')).toBe(true);
    expect(r.isTrackedRel('secrets.yaml')).toBe(true);
  });
});

describe('IgnoreRules — L4 user overrides', () => {
  it('lfct.exclude adds bare directory names', () => {
    const r = rules({ exclude: ['fixtures'] });
    expect(r.isTrackedRel('test/fixtures/big.json')).toBe(false);
    expect(r.shouldPruneDirRel('test/fixtures')).toBe(true);
    expect(r.isTrackedRel('test/unit/x.test.ts')).toBe(true);
  });

  it('lfct.exclude accepts path globs', () => {
    const r = rules({ exclude: ['docs/**/*.png'] });
    expect(r.isTrackedRel('docs/images/a.png')).toBe(false);
    expect(r.isTrackedRel('docs/images/a.svg')).toBe(true);
  });

  it('lfct.include re-includes an ambiguous L2 directory', () => {
    const r = rules({ include: ['bin'] });
    expect(r.isTrackedRel('bin/cli.ts')).toBe(true);
    expect(r.shouldPruneDirRel('bin')).toBe(false);
    // Other L2 names are untouched by that override.
    expect(r.isTrackedRel('dist/app.js')).toBe(false);
  });

  it('lfct.include works for a nested path', () => {
    const r = rules({ include: ['packages/app/bin/**'] });
    expect(r.shouldPruneDirRel('packages')).toBe(false);
    expect(r.shouldPruneDirRel('packages/app')).toBe(false);
    expect(r.shouldPruneDirRel('packages/app/bin')).toBe(false);
    expect(r.isTrackedRel('packages/app/bin/run.ts')).toBe(true);
    // A different project's bin/ stays excluded.
    expect(r.isTrackedRel('packages/other/bin/run.ts')).toBe(false);
  });

  it('lfct.include overrides the size cap but never L1', () => {
    const r = rules({ include: ['bin', 'node_modules'] });
    expect(r.isTrackedRel('bin/large-thing')).toBe(true);
    expect(r.isTrackedRel('node_modules/x/y.js')).toBe(false);
  });
});

describe('IgnoreRules — the ambiguous four (§17.1)', () => {
  for (const name of ['bin', 'env', 'out', 'target']) {
    it(`excludes ${name} by default and re-includes it on request`, () => {
      expect(rules().isTrackedRel(`${name}/thing.ts`)).toBe(false);
      expect(rules({ include: [name] }).isTrackedRel(`${name}/thing.ts`)).toBe(true);
    });
  }
});

describe('IgnoreRules — absolute-path entry point', () => {
  it('rejects paths outside the workspace', () => {
    const r = rules();
    expect(r.isTracked(path.join(ROOT, 'src', 'app.ts'))).toBe(true);
    expect(r.isTracked(path.resolve('/tmp/elsewhere/app.ts'))).toBe(false);
  });
});

describe('IgnoreRules — size cap', () => {
  it('compares against maxFileSizeMB', () => {
    const r = rules({ maxFileSizeMB: 1 });
    expect(r.maxFileBytes).toBe(1024 * 1024);
    expect(r.isSizeWithinCap(1024 * 1024)).toBe(true);
    expect(r.isSizeWithinCap(1024 * 1024 + 1)).toBe(false);
  });
});

describe('staticPrefix', () => {
  const cases: [string, string][] = [
    ['bin', 'bin'],
    ['bin/**', 'bin'],
    ['packages/app/bin/**', 'packages/app/bin'],
    ['packages/*/bin', 'packages'],
    ['**/target/src/**', ''],
    ['*.ts', ''],
    ['src/gen-*.ts', 'src'],
  ];
  for (const [pattern, expected] of cases) {
    it(`${pattern} -> "${expected}"`, () => {
      expect(staticPrefix(pattern)).toBe(expected);
    });
  }
});
