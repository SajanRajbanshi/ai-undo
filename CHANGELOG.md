# Changelog

All notable changes to AI Undo are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
