/**
 * §5.6 — the denylist, in four layers evaluated in order.
 *
 * The critical property, and the reason §5.5 exists: this is *our* list, not
 * the project's `.gitignore`. `.gitignore` conflates "generated junk I don't
 * care about" with "local state that matters enormously", which makes it the
 * wrong signal for a tool whose entire job is protecting the second category.
 * `.env` must be tracked; `node_modules` must not.
 *
 * Adding to L2: a wrongly excluded file has no undo, while a wrongly tracked
 * one is only noise. Only add names a tool owns. Generic words such as `logs`,
 * `tmp`, `public` or `lib` hold real source in too many projects.
 */

/**
 * L1 — universal. Never overridable by `lfct.include`. `.git` because it is the
 * user's real repository and our own writes must not perturb it; `node_modules`
 * because re-including it is never what anyone means and always a performance
 * catastrophe.
 */
export const L1_DIRS: readonly string[] = ['.git', 'node_modules'];

export const L1_FILES: readonly string[] = ['.DS_Store', 'Thumbs.db', 'desktop.ini'];

/** L2 — ecosystem build and dependency directories, matched on any path segment. */
export const L2_DIRS: readonly string[] = [
  // JS / TS
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  '.astro',
  '.angular',
  '.docusaurus',
  '.react-router',
  '.tanstack',
  '.expo',
  '.vite',
  '.swc',
  '.turbo',
  '.parcel-cache',
  '.cache',
  '.nyc_output',
  'coverage',
  'storybook-static',
  'bower_components',
  '.pnpm-store',
  // JS / TS hosting and deploy tools
  '.vercel',
  '.netlify',
  '.wrangler',
  '.firebase',
  '.sst',
  '.open-next',
  // Playwright. `playwright/.cache` is already covered by `.cache` above.
  'test-results',
  'playwright-report',
  'blob-report',
  '.playwright-mcp',
  // Python
  '.venv',
  'venv',
  'env',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.nox',
  '.hypothesis',
  '.pyre',
  '.pytype',
  '.eggs',
  '.pixi',
  '.ipynb_checkpoints',
  'htmlcov',
  // Machine learning
  'mlruns',
  'lightning_logs',
  // Rust / Java / Kotlin / Scala
  'target',
  '.gradle',
  '.m2',
  '.kotlin',
  '.bsp',
  '.metals',
  '.bloop',
  // .NET
  'bin',
  'obj',
  '.vs',
  'TestResults',
  // Go / PHP
  'vendor',
  '.phpunit.cache',
  // iOS / macOS / Android / Flutter
  'Pods',
  'DerivedData',
  '.build',
  '.cxx',
  '.externalNativeBuild',
  '.dart_tool',
  // Haskell / Elixir / Zig / C and C++ / Bazel-like build systems
  '.stack-work',
  'dist-newstyle',
  '_build',
  '.elixir_ls',
  '.zig-cache',
  'zig-out',
  'CMakeFiles',
  'buck-out',
  // Infra
  '.terraform',
  '.terragrunt-cache',
  '.serverless',
  '.aws-sam',
  'cdk.out',
  '.vagrant',
  // Static sites
  '_site',
  '.jekyll-cache',
  '.sass-cache',
  // Editors and tooling
  '.idea',
  '.vscode-test',
  '.history',
  '.direnv',
];

/**
 * L2 — glob patterns matched against each directory name, never against files,
 * so `bazel-*` prunes `bazel-out/` without hiding `docs/bazel-guide.md`.
 */
export const L2_DIR_GLOBS: readonly string[] = [
  'cmake-build-*',
  'bazel-*',
  '.aider.tags.cache.*',
];

/** L2 — glob patterns matched against the basename. */
export const L2_FILE_GLOBS: readonly string[] = [
  // Editors
  '*.pyc',
  '*.pyo',
  '*.swp',
  '*.swo',
  '*~',
  // Lock files that office suites create beside an open document
  '~$*',
  '.~lock.*#',
  // macOS metadata written onto non-Apple volumes
  '._*',
  // Logs
  '*.log',
  // Tool caches
  '*.tsbuildinfo',
  '.eslintcache',
  '.stylelintcache',
  '.coverage',
  '.coverage.*',
  '.phpunit.result.cache',
  '.php-cs-fixer.cache',
  '.flutter-plugins',
  '.flutter-plugins-dependencies',
  // Aider's own history, rewritten on every turn
  '.aider.chat.history.md',
  '.aider.input.history',
];

/** L2 — glob patterns matched against the full workspace-relative path. */
export const L2_PATH_GLOBS: readonly string[] = [
  '**/*.egg-info/**',
  '**/*.egg-info',
  '**/*.xcworkspace/xcuserdata/**',
  '**/*.xcodeproj/xcuserdata/**',
  // Playwright's saved login state. Anchored to `playwright/` because a bare
  // `.auth` is too generic a name to exclude everywhere.
  '**/playwright/.auth/**',
  '**/playwright/.auth',
  // Generated state inside a directory that also holds committed files, such
  // as `.nx/nxw.js` or `.yarn/releases`.
  '**/.nx/cache/**',
  '**/.nx/cache',
  '**/.nx/workspace-data/**',
  '**/.nx/workspace-data',
  '**/.yarn/cache/**',
  '**/.yarn/cache',
  '**/.yarn/unplugged/**',
  '**/.yarn/unplugged',
  '**/.yarn/install-state.gz',
  '**/.vitepress/cache/**',
  '**/.vitepress/cache',
  '**/.vuepress/.temp/**',
  '**/.vuepress/.temp',
  '**/Carthage/Build/**',
  '**/Carthage/Build',
  // Framework runtime state under names too generic to exclude everywhere:
  // Laravel's `storage/framework` and `bootstrap/cache`, Symfony's `var/cache`.
  '**/storage/framework/**',
  '**/storage/framework',
  '**/bootstrap/cache/**',
  '**/bootstrap/cache',
  '**/var/cache/**',
  '**/var/cache',
  // Weights & Biases run output. A bare `wandb` would also hide an integration
  // module of that name, so only its run directories are matched.
  '**/wandb/run-[0-9]*/**',
  '**/wandb/run-[0-9]*',
  '**/wandb/offline-run-[0-9]*/**',
  '**/wandb/offline-run-[0-9]*',
  '**/wandb/latest-run',
];

/**
 * §5.6 — `bin`, `env`, `out` and `target` legitimately hold source in some
 * projects. §17.1 resolves this as: exclude by default, but notice it once so
 * the gap is never silent, and let `lfct.include` override.
 */
export const AMBIGUOUS_DIRS: readonly string[] = ['bin', 'env', 'out', 'target'];

/**
 * Extensions that suggest a directory holds real source rather than build
 * output, used only for the one-time §17.1 notice.
 *
 * `.js`, `.jsx`, `.mjs` and `.cjs` are deliberately absent. Compiled and
 * bundled JavaScript is the single most common thing inside `out/`, `bin/` and
 * `target/`, so including them would fire this notice on essentially every
 * JavaScript project — and a warning that is always wrong is a warning people
 * learn to dismiss. Missing the notice is cheap: the directory just stays
 * excluded, which is the documented default, and `lfct.include` still works.
 */
export const SOURCE_EXTENSIONS: readonly string[] = [
  '.ts',
  '.tsx',
  '.py',
  '.rs',
  '.go',
  '.java',
  '.kt',
  '.rb',
  '.php',
  '.cs',
  '.c',
  '.h',
  '.cc',
  '.cpp',
  '.hpp',
  '.swift',
  '.sh',
  '.sql',
  '.vue',
  '.svelte',
];
