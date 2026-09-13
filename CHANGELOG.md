# Changelog

All notable changes to AI Undo are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Playwright output is no longer tracked.** `test-results`, `playwright-report`,
  `blob-report`, `playwright/.auth` and `.playwright-mcp` are now excluded by default,
  so a test run no longer fills the change list with traces, screenshots and reports.
  Test files, `playwright.config.*` and committed `*-snapshots` baselines are still
  tracked.
- **More framework and tool output is excluded by default**, so installs, builds and
  dev servers stop filling the change list: hosting and framework caches (`.vercel`,
  `.netlify`, `.wrangler`, `.angular`, `.astro`, `.output`, `.expo`, `storybook-static`
  and more), Flutter, Android, SwiftPM and Kotlin build state, Python and ML caches
  (`.ipynb_checkpoints`, `htmlcov`, `.coverage`, `mlruns`, W&B runs), Haskell, Elixir,
  Zig, Scala, C/C++, .NET, Bazel and Buck output, Laravel and Symfony caches, infra
  tooling (`cdk.out`, `.aws-sam`, `.terragrunt-cache`, `.vagrant`), Jekyll output,
  Aider history, the Local History extension's `.history`, office lock files,
  `desktop.ini`, `._*` and `*.log`. Every entry except `desktop.ini` can be re-tracked
  with `lfct.include`. The full list is in `src/scan/defaults.ts`.
- Lockfiles, `terraform.tfstate`, SQLite databases, `local.properties` and generic
  directory names such as `public`, `lib`, `logs` and `tmp` remain tracked on purpose.

### Fixed

- **A stash no longer accepts the changes it sets aside.** `git stash` followed by
  `git stash pop` was treated as two unrelated git operations and both were
  auto-accepted, so every change that was pending before the stash dropped out of the
  list and could no longer be rejected. Pending content a git operation takes off disk
  is now remembered. When the same content comes back, through `pop`, `apply`,
  `stash -u` or the Source Control view, those files are listed again against their
  original baseline. A pop that merges with newer commits is still auto-accepted.

## [1.0.0] — 2026-07-28

No functional changes since 0.1.0. The version marks the extension as stable and
documented rather than any change in behaviour.

### Changed

- **Installation is now the first thing the README covers**, immediately after what
  the extension is for: marketplace search for the forks, and a `.vsix` download for
  everyone else.
- **Per-platform install commands.** Separate, copy-pasteable lines for macOS, Linux,
  Windows PowerShell and Windows Command Prompt, saying where to run them, plus the
  `code: command not found` recovery for each platform.
- **Screencasts** of installing from a `.vsix`, and of reviewing a pending change.
- Documentation assets live in `docs/` and are excluded from the packaged extension,
  so the VSIX is unchanged in content and size.

## [0.1.0] — 2026-07-25

Initial release.

### Added

- **Pending-change list.** A Source Control provider, **AI Changes**, listing every file an
  external process wrote, with per-file Accept and Reject.
- **Durable baseline.** A shadow git repository outside the work tree, snapshotted eagerly so
  the *first* change to a file is recoverable. Survives reloads and restarts.
- **Method-agnostic, not just agent-agnostic.** Detection is on the filesystem, so an edit made by
  an agent's own tool and an edit made by a script it shelled out to — `sed`, a formatter, a
  codemod, a migration — are recorded identically. Agent-native checkpoints record only the former.
- **Attribution.** Your own saves advance the baseline silently and never appear in the list;
  writes from an agent do. Git operations — pull, rebase, stash, checkout — are recognised and
  auto-accepted by default, because those already have the reflog as a safety net.
- **Full-file diff view.** Clicking a change opens the whole file with every removed and added
  line shown, syntax highlighted, with real line numbers. Configurable via `lfct.diffView`.
- **Per-hunk review.** Reject or Keep an individual change from the editor, or from VS Code's
  own change peek via the gutter bar.
- **Everything is tracked, not just what git tracks.** A newly created `.env` is exactly the
  file you most want back, so file selection is the extension's own — see the README for what
  that means for secrets.
- **Storage management.** `Manage Checkpoint Storage` lists every workspace's baseline with its
  size, and deletes them.

### Added

- **Source Control provider** ("AI Changes") listing every file that diverges
  from its baseline, with per-file Accept and Reject, bulk Accept All and
  Reject All, and an Activity Bar count badge.
- **Inline unified diff** as the default click action: a single column with
  additions and deletions interleaved, rendered with VS Code's built-in `diff`
  grammar. Side-by-side remains available per file or as a default.
- **Quick-diff gutter bars** in every open file, with native inline peek of the
  baseline lines.
- **Durable baselines** in a shadow git repository held in extension storage —
  never inside the project — surviving window reload, workspace close and
  machine restart, and retained indefinitely.
- **Tracking of gitignored local state** such as `.env`, while excluding
  dependency and build directories. File selection is owned by the extension,
  so no ignore source participates.
- **Attribution** distinguishing your own editor saves (which advance the
  baseline silently) from external writes (which surface for review).
- **Git-operation detection**: `pull`, `rebase`, `stash`, `reset` and `checkout`
  are auto-accepted rather than listed, so Reject All can never undo a pull.
  Configurable via `lfct.gitOperations`, and every occurrence is logged.
- **Reconciliation sweeps** on activation, focus, directory events, bursts and a
  low-frequency timer, so correctness never depends on the file watcher alone.
- Byte-exact restore for modified, created and deleted files, including CRLF,
  BOM, binary content and projects using Git LFS.
- Storage management: `Reveal Checkpoint Storage`, `Manage Checkpoint Storage`
  and `Rebuild Baseline From Disk`.

### Known limitations

A single rolling baseline (no per-turn rewind), no per-hunk operations, no
multi-root workspaces, no support claimed for Remote/SSH/WSL/Codespaces, and no
coverage of in-editor agents. See the README for the full list.
