/**
 * §5.6 — the denylist, in four layers evaluated in order.
 *
 * The critical property, and the reason §5.5 exists: this is *our* list, not
 * the project's `.gitignore`. `.gitignore` conflates "generated junk I don't
 * care about" with "local state that matters enormously", which makes it the
 * wrong signal for a tool whose entire job is protecting the second category.
 * `.env` must be tracked; `node_modules` must not.
 */

/**
 * L1 — universal. Never overridable by `lfct.include`. `.git` because it is the
 * user's real repository and our own writes must not perturb it; `node_modules`
 * because re-including it is never what anyone means and always a performance
 * catastrophe.
 */
export const L1_DIRS: readonly string[] = ['.git', 'node_modules'];

export const L1_FILES: readonly string[] = ['.DS_Store', 'Thumbs.db'];

/** L2 — ecosystem build and dependency directories, matched on any path segment. */
export const L2_DIRS: readonly string[] = [
  // JS / TS
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.parcel-cache',
  '.cache',
  'coverage',
  'bower_components',
  // Python
  '.venv',
  'venv',
  'env',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  // Rust / Java / Kotlin
  'target',
  '.gradle',
  '.m2',
  // .NET
  'bin',
  'obj',
  // Go / PHP
  'vendor',
  // iOS / macOS
  'Pods',
  'DerivedData',
  // Infra
  '.terraform',
  '.serverless',
  // Editors and tooling
  '.idea',
  '.vscode-test',
];

/** L2 — glob patterns matched against the basename. */
export const L2_FILE_GLOBS: readonly string[] = ['*.pyc', '*.pyo', '*.swp', '*.swo', '*~'];

/** L2 — glob patterns matched against the full workspace-relative path. */
export const L2_PATH_GLOBS: readonly string[] = [
  '**/*.egg-info/**',
  '**/*.egg-info',
  '**/*.xcworkspace/xcuserdata/**',
  '**/*.xcodeproj/xcuserdata/**',
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
