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

describe('IgnoreRules — Playwright output', () => {
  const cases: [string, boolean][] = [
    ['test-results/login-chromium/trace.zip', false],
    ['test-results/.last-run.json', false],
    ['playwright-report/index.html', false],
    ['blob-report/report-1.zip', false],
    ['playwright/.cache/index.html', false],
    ['playwright/.auth/user.json', false],
    ['.playwright-mcp/page-2026-09-13.png', false],
    ['packages/web/test-results/login-chromium/video.webm', false],
    // What the user writes and commits stays tracked.
    ['playwright.config.ts', true],
    ['tests/login.spec.ts', true],
    ['tests/login.spec.ts-snapshots/login-chromium-darwin.png', true],
    ['playwright/index.tsx', true],
  ];

  for (const [relPath, expected] of cases) {
    it(`${expected ? 'tracks' : 'excludes'} ${relPath}`, () => {
      expect(rules().isTrackedRel(relPath)).toBe(expected);
    });
  }

  it('prunes the output directories before descending', () => {
    const r = rules();
    expect(r.shouldPruneDirRel('test-results')).toBe(true);
    expect(r.shouldPruneDirRel('playwright-report')).toBe(true);
    expect(r.shouldPruneDirRel('playwright/.auth')).toBe(true);
    expect(r.shouldPruneDirRel('playwright')).toBe(false);
  });
});

describe('IgnoreRules — framework and tool output', () => {
  const excluded = [
    // JS / TS frameworks and tooling
    '.output/server/index.mjs',
    '.vercel/output/config.json',
    '.netlify/functions/x.js',
    '.wrangler/state/v3/d1/db.sqlite',
    '.angular/cache/19.0.0/babel-webpack/x.json',
    '.astro/types.d.ts',
    '.expo/devices.json',
    '.docusaurus/routes.js',
    '.react-router/types/app/+types/root.ts',
    '.tanstack/tmp/x.js',
    '.vite/deps/react.js',
    '.swc/plugins/x.wasm',
    '.sst/platform/x.ts',
    '.open-next/server-functions/default/index.mjs',
    '.firebase/hosting.cHVibGlj.cache',
    'storybook-static/index.html',
    '.nyc_output/processinfo/x.json',
    '.pnpm-store/v3/files/00/abc',
    '.nx/cache/123/outputs/x',
    '.nx/workspace-data/project-graph.json',
    '.yarn/cache/react-npm-18.3.1-abc.zip',
    '.yarn/unplugged/esbuild-npm-0.21.5/node_modules/esbuild/bin/esbuild',
    '.yarn/install-state.gz',
    'docs/.vitepress/cache/deps/vue.js',
    'docs/.vuepress/.temp/app.js',
    'tsconfig.tsbuildinfo',
    '.eslintcache',
    '.stylelintcache',
    // Mobile
    '.dart_tool/package_config.json',
    '.flutter-plugins',
    '.flutter-plugins-dependencies',
    'android/app/.cxx/Debug/x.o',
    'android/app/.externalNativeBuild/cmake/x',
    '.build/debug/App',
    'Carthage/Build/iOS/Alamofire.framework/Info.plist',
    '.kotlin/sessions/x.salive',
    // Python and machine learning
    'notebooks/.ipynb_checkpoints/eda-checkpoint.ipynb',
    'htmlcov/index.html',
    '.coverage',
    '.coverage.myhost.1234.XyZ',
    '.hypothesis/examples/x',
    '.nox/tests/bin/python',
    '.pyre/resource_cache/x',
    '.pytype/imports/x.imports',
    '.eggs/setuptools_scm-8.0.egg/x',
    '.pixi/envs/default/bin/python',
    '.direnv/python-3.12/bin/python',
    'mlruns/0/abc/metrics/loss',
    'wandb/run-20260913_205801-abc123xy/files/config.yaml',
    'wandb/offline-run-20260913_205801-abc123xy/logs/x.txt',
    'wandb/latest-run',
    'lightning_logs/version_0/hparams.yaml',
    // Other languages
    '.stack-work/dist/x',
    'dist-newstyle/cache/plan.json',
    '_build/dev/lib/app/ebin/app.app',
    'docs/_build/html/index.html',
    '.elixir_ls/build/x',
    '.zig-cache/o/abc/x',
    'zig-out/bin/app',
    '.bsp/sbt.json',
    '.metals/metals.mv.db',
    '.bloop/root.json',
    'cmake-build-debug/CMakeCache.txt',
    'native/cmake-build-release/app',
    'build-tree/CMakeFiles/app.dir/main.cpp.o',
    '.vs/App/v17/.suo',
    'TestResults/run.trx',
    'bazel-out/k8-fastbuild/bin/app',
    'bazel-testlogs/x/test.log',
    'buck-out/gen/x',
    // PHP
    '.phpunit.cache/test-results',
    '.phpunit.result.cache',
    '.php-cs-fixer.cache',
    'storage/framework/views/abc.php',
    'bootstrap/cache/packages.php',
    'var/cache/dev/App_KernelDevDebugContainer.php',
    // Infra and static sites
    '.terragrunt-cache/abc/x.tf',
    '.aws-sam/build/template.yaml',
    'cdk.out/manifest.json',
    '.vagrant/machines/default/virtualbox/id',
    '_site/index.html',
    '.jekyll-cache/Jekyll/Cache/x',
    '.sass-cache/abc/x.scssc',
    // AI tools
    '.aider.chat.history.md',
    '.aider.input.history',
    '.aider.tags.cache.v4/cache.db',
    // Editors and OS
    '.history/src/app_20260913205801.ts',
    'desktop.ini',
    'assets/desktop.ini',
    '._photo.jpg',
    '~$report.docx',
    '.~lock.report.odt#',
    // Logs
    'npm-debug.log',
    'yarn-error.log',
    'log/development.log',
  ];

  // A wrongly excluded file has no undo, so these matter as much as the
  // exclusions: generic names, committed state, and files that merely
  // resemble a pattern above.
  const tracked = [
    'package-lock.json',
    'yarn.lock',
    'terraform.tfstate',
    'db.sqlite3',
    'android/local.properties',
    'public/assets/logo.png',
    'lib/main.dart',
    'packages/app/src/index.ts',
    'internal/logs/logs.go',
    'tmp/keep.txt',
    'CHANGELOG.md',
    'src/catalog.ts',
    '.coveragerc',
    'docs/bazel-guide.md',
    'src/integrations/wandb/__init__.py',
    'wandb/settings',
    '.nx/nxw.js',
    'nx.json',
    '.yarn/releases/yarn-4.5.0.cjs',
    '.yarn/patches/react-npm-18.3.1.patch',
    'docs/.vitepress/config.ts',
    'storage/app/uploads/avatar.png',
    'var/data/seed.json',
    '.claude/settings.json',
    '.storybook/main.ts',
    'src/__snapshots__/app.test.ts.snap',
    'src/__generated__/schema.graphql.ts',
    'prisma/migrations/20260913_init/migration.sql',
    '.aider.conf.yml',
    'src/.history.ts',
  ];

  for (const relPath of excluded) {
    it(`excludes ${relPath}`, () => {
      expect(rules().isTrackedRel(relPath)).toBe(false);
    });
  }

  for (const relPath of tracked) {
    it(`tracks ${relPath}`, () => {
      expect(rules().isTrackedRel(relPath)).toBe(true);
    });
  }

  it('matches directory globs against directories only', () => {
    const r = rules();
    expect(r.shouldPruneDirRel('bazel-out')).toBe(true);
    expect(r.shouldPruneDirRel('native/cmake-build-debug')).toBe(true);
    expect(r.shouldPruneDirRel('.aider.tags.cache.v4')).toBe(true);
    expect(r.isTrackedRel('bazel-notes.md')).toBe(true);
    expect(r.isTrackedRel('cmake-build-flags.txt')).toBe(true);
  });

  it('prunes anchored cache directories but not their committed parents', () => {
    const r = rules();
    expect(r.shouldPruneDirRel('.nx/cache')).toBe(true);
    expect(r.shouldPruneDirRel('.yarn/cache')).toBe(true);
    expect(r.shouldPruneDirRel('storage/framework')).toBe(true);
    expect(r.shouldPruneDirRel('.nx')).toBe(false);
    expect(r.shouldPruneDirRel('.yarn')).toBe(false);
    expect(r.shouldPruneDirRel('storage')).toBe(false);
    expect(r.shouldPruneDirRel('wandb')).toBe(false);
  });

  it('lets lfct.include re-track an L2 entry', () => {
    const r = rules({ include: ['*.log', '_build'] });
    expect(r.isTrackedRel('fixtures/server.log')).toBe(true);
    expect(r.isTrackedRel('_build/app.ex')).toBe(true);
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
