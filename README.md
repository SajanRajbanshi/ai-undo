# AI Undo

**An undo boundary for files changed by CLI coding agents — whichever agent you use, and whatever it used to make the change.**

Claude Code, opencode, Codex and friends edit files on disk directly. By the time you notice, the change is already applied. This extension keeps a durable, per-file baseline of your whole project so you can review what changed and put any of it back.

**It watches the filesystem, not the agent.** So it catches the edits an agent makes with its own tools *and* the ones it makes by running something else — `sed`, a formatter, a codemod, a migration script, a `mv`. Agents reach for the shell constantly, and those writes are exactly the ones their own checkpoints don't record. Anything that writes a file is covered, including your own build scripts and tools that have nothing to do with AI.

---

## Why the existing safety nets don't cover this

| | Gap |
| --- | --- |
| **Git** | Only helps if you committed at the right moment. In practice the agent's edits land on top of your own uncommitted work, so `git checkout` throws away both. |
| **Editor undo** | Per-buffer, dies on window reload, and covers nothing the agent created or deleted while the file was closed. |
| **Agent-native checkpoints** (Cursor, Antigravity, Claude Code) | Only cover edits made by *that* agent, through *its own edit tool*. The moment it shells out — `sed`, a formatter, a codemod — the write happens outside the checkpoint and is not recorded. Claude Code's own docs say so: changes made via bash commands are not tracked. |

This extension does forensic attribution after the fact, which is harder — and is exactly what makes it work across every agent instead of one, and across every *method* instead of one.

---

## How it works

A **Source Control** provider called **AI Changes** appears alongside Git:

```
▼ AI Changes                              3
    src/app.ts                  ✓  ↺      M
    .env                        ✓  ↺      M
    src/generated.ts            ✓  ↺      A
    src/old-helper.ts           ✓  ↺      D
```

Click a file to review it. Then:

### Reviewing a change

Clicking a file opens **the whole file**, not just the changed region — highlighted in its own language, with real line numbers, and **every removed line shown in full**. Nothing is summarised or hidden behind a hover, because a change you don't notice is the one that costs you.

```
    86     private burstStartedAt = 0;
    87     private burstLastEventAt = 0;
    88  +  /** Throttles the suppression sweep. */
    89  +  private lastSuppressionSweepAt = 0;
    90     private burstTimer: unknown;
```

A removed line is numbered in the baseline and an added line in the file on disk, so the number always tells you where that line actually lives.

The same diff is reachable from anywhere: the **AI Changes** list, the compare button in the editor toolbar of any changed file, right-clicking in the Explorer, or **Open AI Changes** in the Command Palette.

### Accept and Reject, per file or per change

**Reject** and **Keep** appear above each individual change in the editor, so you can take one edit and drop another in the same file. They're also in the title bar of VS Code's own change peek — click a gutter bar to get every removed line in place, with the buttons right there.

### Accept and Reject are not symmetric

| Action | Effect on disk | What it's for |
| --- | --- | --- |
| **Accept** | **None.** | Bookkeeping only. Moves the baseline forward so the file stops being reported. |
| **Reject** | **Overwrites the file.** | The actual product. Restores the baseline bytes, or deletes the file if the baseline says it never existed. |

Accept is free and cheap. Reject is the feature. Everything else follows from that.

You also get **quick-diff gutter bars** in every open file, showing exactly which lines changed, live — click one to peek the original inline.

### Your own edits never show up

When you save a file yourself, the baseline advances silently. Nothing appears in the list, no badge, no notification. That's what keeps the list meaningful: everything in it came from somewhere other than your keyboard.

### Git operations don't show up either

`git pull`, `rebase`, `stash`, `reset` and `checkout` all rewrite files from outside the editor. Those are auto-accepted rather than listed, because **git operations already have the reflog and `ORIG_HEAD` as a safety net, and agent writes have nothing.** Without this, Reject All after a `git pull` would undo the pull.

Every auto-accepted operation is recorded in the extension's output channel. Change the behavior with `lfct.gitOperations` if you'd rather review them.

---

## Installing

**Cursor, Antigravity, Windsurf, VSCodium** — search for **AI Undo** in the Extensions view. These install from [Open VSX](https://open-vsx.org).

**Any editor, from a file** — download `ai-undo-<version>.vsix` from the [latest release](https://github.com/SajanRajbanshi/ai-undo/releases), then either:

```bash
code --install-extension ai-undo-0.1.0.vsix     # or: cursor / codium / antigravity-ide
```

or in the editor: **Extensions** view → `···` menu → **Install from VSIX…**

A VSIX install does not auto-update, so watch the [releases page](https://github.com/SajanRajbanshi/ai-undo/releases) if you install this way.

---

## Requirements

- **`git` 2.26 or newer on your `PATH`.** The checkpoint store *is* a git repository — one that lives in VS Code's extension storage, never in your project. Activation fails with an actionable message if git is missing.
- A single-folder workspace. Multi-root is detected and the extension disables itself.

---

## What gets tracked

Tracking is governed by the extension's own denylist, **deliberately independent of your `.gitignore`**.

`.gitignore` conflates two unrelated things: *generated junk nobody cares about* and *local state that matters enormously*. It's the wrong signal for a tool whose job is protecting the second category.

**Tracked**, even when gitignored:

- `.env`, `.env.local` and friends
- `config/local.json` and other ignored local state
- everything else in your project

**Never tracked:**

- `.git`, `node_modules` (not overridable)
- Build and dependency output: `dist`, `build`, `out`, `.next`, `target`, `bin`, `obj`, `vendor`, `.venv`, `__pycache__`, `Pods`, `.terraform`, and [more](src/scan/defaults.ts)
- Files larger than `lfct.maxFileSizeMB` (default 5 MB)
- Nested repositories and submodules

`bin`, `env`, `out` and `target` are ambiguous — usually build output, occasionally real source. They're excluded by default, but if one looks like it holds source you'll get a one-time prompt offering to track it. You can always adjust with `lfct.include`.

---

## ⚠️ `.env` and secrets — please read

**This extension tracks `.env` and other gitignored files by design.** That's the point: those are the files with no other safety net.

The consequence is that **their historical contents are stored, unencrypted, in a local git object store, indefinitely.**

- The store never has a remote, and nothing in this extension touches the network.
- It lives in VS Code's per-workspace extension storage, not in your project, so it is never committed or pushed.
- It inherits the permissions of your VS Code profile directory.

To see where it lives, run **AI Undo: Reveal Checkpoint Storage**. To delete stores (including for projects you've since deleted), run **Manage Checkpoint Storage**.

**Uninstalling the extension does not remove these stores.** VS Code doesn't clean `workspaceStorage`. Delete them explicitly if that matters to you.

---

## Commands

| Command | Where |
| --- | --- |
| Accept / Reject | Inline buttons on each row, and the context menu |
| Accept All Changes / Reject All Changes | Source Control title bar |
| Open AI Changes | Clicking a row; the compare button in the editor toolbar of a changed file; Explorer right-click; Command Palette |
| Keep This Change / Reject This Change | Above each change in the editor, and in the title bar of the gutter-bar peek |
| Open Changes (Side by Side) | Context menu |
| Toggle Inline / Side-by-Side Diff | Command Palette |
| Refresh | Source Control title bar |
| Rebuild Baseline From Disk | Command Palette |
| Reveal Checkpoint Storage | Command Palette |
| Manage Checkpoint Storage | Command Palette |
| Show Log | Command Palette |

Reject asks for confirmation when it would delete a file, discard unsaved editor work, or run across everything at once. It doesn't ask for a single clean modified file — being asked every time just trains you to click through.

---

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `lfct.enabled` | `true` | Master switch. Needs a window reload. |
| `lfct.exclude` | `[]` | Extra patterns to exclude. |
| `lfct.include` | `[]` | Patterns to re-include, overriding built-in exclusions and the size cap. Cannot override `.git` or `node_modules`. |
| `lfct.maxFileSizeMB` | `5` | Files above this are not tracked. |
| `lfct.notification` | `toast` | `toast`, `badge`, or `none`. One notification per burst, never per file. |
| `lfct.diffView` | `patch` | What clicking a changed file opens. `patch` shows every removed and added line in one column; `liveFile` opens the real, editable file with changes decorated in place; `sideBySide` opens the native two-pane editor. |
| `lfct.showHunkControls` | `true` | Show Reject and Keep above each change in the editor. |
| `lfct.gitOperations` | `auto-accept` | `auto-accept`, `surface`, or `prompt`. |
| `lfct.userEditGraceMs` | `2000` | How long an anticipated save stays valid. |
| `lfct.burstQuietMs` | `750` | Quiet period before a burst of writes is considered settled. |
| `lfct.gitOpWindowMs` | `3000` | Tolerance for correlating a burst with a `.git` marker change. |
| `lfct.reconcileIntervalMs` | `60000` | Periodic full reconciliation. `0` disables. |
| `lfct.confirmReject` | `destructive` | `always`, `destructive`, or `never`. |
| `lfct.fsMonitor` | `off` | Enable git's `core.fsmonitor` in the store. Only worth it on very large trees; spawns a background daemon. macOS/Windows, git ≥ 2.37. |

Changing `lfct.exclude`, `lfct.include` or `lfct.maxFileSizeMB` changes which files are tracked, so you'll be prompted to rebuild the baseline. It's never done silently, because a rebuild discards pending changes by definition.

---

## Known limitations

These are deliberate scope decisions for v1, not oversights.

- **One rolling baseline.** Reject goes back to the last Accept, not to the last agent turn. Accepting frequently keeps the boundary tight.
- **In-editor agents** (Kilo Code, Cline, Copilot Agent) mutate the document through the editor API, which is indistinguishable from you typing. Not covered.
- **Removed lines can't be shown in full in the `liveFile` view.** Deleted lines don't exist in the buffer and no extension API can make the editor reserve space for them, so that view marks them and shows the first. The default `patch` view and the gutter-bar peek both show them completely.
- **No multi-root workspaces.** Detected, and the extension disables itself.
- **Remote / SSH / WSL / Codespaces are untested.** No support is claimed, and virtual workspaces are declared unsupported.
- **Renames appear as a delete plus an add**, so a 200-file folder rename shows 400 rows. Correct, but verbose.
- **Editing a file in vim or another external editor** is reported as an external change. A harmless false positive.
- **<kbd>Cmd</kbd>+<kbd>Z</kbd> after rejecting a single change** puts the agent's version back — the edit goes through the editor, so it joins the undo stack deliberately. After a whole-file Reject, which writes through git, undo is not guaranteed.
- **`git checkout -- .`** moves no ref, so it isn't recognized as a git operation and surfaces as pending changes. Accept All clears it.
- **Baselines don't sync across machines**, and moving or renaming a project starts a fresh one.

---

## Development

```bash
npm install
npm run check-types     # tsc
npm run lint            # eslint
npm run test:unit       # vitest, no VS Code, no git
npm run test:integration # real git against real temp filesystems
npm run test:perf       # order-of-magnitude regression guard
npm run test:suite      # full extension host via @vscode/test-electron
npm run package         # vsce package
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host.

The architecture, the reasoning behind it, and the edge-case matrix are documented in `PLAN.md` in the repository. Two design decisions carry most of the correctness risk and have the test coverage to match:

- **File selection is not git's.** If git owned it, a newly created file matching `.gitignore` would be invisible — which is exactly the file you most want back.
- **The project's `.gitattributes` is neutralized.** Otherwise Git LFS silently replaces your files with pointer files on restore.

## License

MIT — see [LICENSE](LICENSE).
