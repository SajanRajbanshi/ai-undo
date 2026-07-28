import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

import type { LfctConfig } from '../config';
import type { ChangeDetector } from '../detect/ChangeDetector';
import {
  HunkStaleError,
  acceptHunksIntoBaseline,
  findHunk,
  hunksCoveredBy,
  revertAll,
  sameTextIgnoringEncoding,
  type Hunk,
  type LineChange,
} from '../diff/hunks';
import type { DecoratedDocument, InlineDiffDecorator } from './InlineDiffDecorator';
import type { Logger } from '../log';
import type { CheckpointStore, FileStatus, FileStatusCode } from '../store/CheckpointStore';
import { formatBytes } from '../store/patch';
import { META_FILE_NAME, SHADOW_DIR_NAME, type StoreMeta } from '../store/init';
import { toAbs } from '../util/paths';
import { patchLanguageFor } from './patchLanguage';
import { resolveCommandTargets, type ScmProvider } from './ScmProvider';
import { baselineUri, emptyUri, patchUri } from './uris';

/**
 * §4.4 / §8.3 / §8.4 — command handlers.
 *
 * The asymmetry from §1.1 governs everything here: Accept never touches disk
 * and is therefore safe and cheap, while Reject overwrites the work tree and is
 * the actual product. That is why Accept has no confirmation path at all and
 * Reject has three.
 */

export interface CommandDeps {
  store: CheckpointStore;
  scm: ScmProvider;
  detector: ChangeDetector;
  // `walker` and `notifier` deliberately absent: nothing here uses them, and
  // the walker in particular is replaced wholesale by a baseline rebuild, so a
  // captured reference would silently go stale. Re-add as `() => T` if needed.
  decorator: InlineDiffDecorator;
  log: Logger;
  config: () => LfctConfig;
  worktree: string;
  storagePath: string;
  isReady: () => boolean;
  /** Full reconciliation, awaited so a command's UI is never stale on return. */
  refresh: (reason: string) => Promise<void>;
  /** Fires onDidChange on both content providers (§7.5.1). */
  invalidateContent: (relPaths: readonly string[]) => void;
  rebuildBaseline: () => Promise<void>;
  showLog: () => void;
}

export function registerCommands(deps: CommandDeps): vscode.Disposable[] {
  const register = (id: string, handler: (...args: any[]) => unknown) =>
    vscode.commands.registerCommand(id, handler);

  return [
    register('lfct.acceptFile', (...args) => acceptCommand(deps, args)),
    register('lfct.rejectFile', (...args) => rejectCommand(deps, args)),
    register('lfct.acceptAll', () => acceptAll(deps)),
    register('lfct.rejectAll', () => rejectAll(deps)),
    register('lfct.openDiff', (...args) => openDiff(deps, args, deps.config().diffView)),
    register('lfct.openDiffSideBySide', (...args) => openDiff(deps, args, 'sideBySide')),
    register('lfct.toggleDiffView', () => toggleDiffView(deps)),
    register('lfct.refresh', () => deps.refresh('command')),
    register('lfct.revealStorage', () => revealStorage(deps)),
    register('lfct.listStores', () => listStores(deps)),
    register('lfct.rebuildBaseline', () => deps.rebuildBaseline()),
    register('lfct.showLog', () => deps.showLog()),
    register('lfct.rejectHunk', (arg) => rejectHunk(deps, arg)),
    register('lfct.acceptHunk', (arg) => acceptHunk(deps, arg)),
    register('lfct.rejectChange', (...args) => rejectChange(deps, args)),
    register('lfct.acceptChange', (...args) => acceptChange(deps, args)),
  ];
}

// ------------------------------------------------------------------ per-hunk

interface HunkRef {
  relPath: string;
  hunkId: string;
}

/**
 * Resolves a CodeLens argument to a live hunk.
 *
 * Always recomputes first. The cached hunks go stale the instant a previous
 * Accept moves the baseline, and the lenses on screen are not repainted until
 * the decorator's debounce fires — so a user working down a file faster than
 * that would otherwise act on coordinates that no longer mean anything. The
 * lookup is by content id rather than array index for the same reason: a stale
 * click must resolve to the right change or to none, never to its neighbour.
 */
async function resolveHunk(
  deps: CommandDeps,
  ref: HunkRef,
): Promise<{ decorated: DecoratedDocument; hunk: Hunk } | undefined> {
  const decorated = await deps.decorator.recompute(ref.relPath);
  const hunk = decorated && findHunk(decorated.hunks, ref.hunkId);
  if (!decorated || !hunk) {
    vscode.window.showWarningMessage('That change is no longer available; the file has moved on.');
    return undefined;
  }
  return { decorated, hunk };
}

/**
 * Reject one hunk: splice the baseline's lines back into the buffer, leaving
 * every other hunk exactly as the agent left it.
 *
 * Applied through a `WorkspaceEdit` on the open document rather than by writing
 * the file, so the change joins the editor's undo stack — Cmd+Z puts the agent's
 * version back, which is the behaviour people expect from an inline control.
 */
async function rejectHunk(deps: CommandDeps, ref: HunkRef | undefined): Promise<void> {
  if (!ref || !(await requireReady(deps))) return;

  const resolved = await resolveHunk(deps, ref);
  if (!resolved) return;
  await rejectHunks(deps, ref.relPath, resolved.decorated, [resolved.hunk]);
}

/**
 * The one splice path, shared by the CodeLens controls and by the buttons in
 * VS Code's own change peek. `revertAll` applies back to front, so a single
 * hunk and a group of them behave identically.
 */
async function rejectHunks(
  deps: CommandDeps,
  relPath: string,
  decorated: DecoratedDocument,
  hunks: readonly Hunk[],
): Promise<void> {
  const uri = vscode.Uri.file(toAbs(deps.worktree, relPath));
  const doc = vscode.workspace.textDocuments.find((d) => pathsEqual(d.uri.fsPath, uri.fsPath));
  if (!doc) return;

  // The document must be exactly what the hunks were computed against, or the
  // splice lands on the wrong lines.
  if (doc.version !== decorated.documentVersion) {
    deps.decorator.invalidate([relPath]);
    vscode.window.showWarningMessage('The file changed while you were reviewing; try again.');
    return;
  }

  let updated: string;
  try {
    updated = revertAll(doc.getText(), hunks);
  } catch (err) {
    if (err instanceof HunkStaleError) {
      deps.decorator.invalidate([relPath]);
      vscode.window.showWarningMessage('That change no longer matches the file; refreshed.');
      return;
    }
    throw err;
  }

  // Captured before the edit: applyEdit dirties the document, so checking
  // afterwards would always report true and we would never save.
  const wasDirtyBeforeEdit = doc.isDirty;

  deps.detector.suppressPath(uri.fsPath);

  const edit = new vscode.WorkspaceEdit();
  const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
  edit.replace(uri, fullRange, updated);
  if (!(await vscode.workspace.applyEdit(edit))) {
    vscode.window.showErrorMessage(`Could not reject that change in ${relPath}.`);
    return;
  }

  // Only auto-save a document the user had not already dirtied. Silently saving
  // over someone's unsaved work is exactly what §4.5 refuses to do without
  // asking; if it was already dirty, leave the reject in the buffer for them to
  // save deliberately.
  if (!wasDirtyBeforeEdit) {
    await doc.save();
  }

  deps.decorator.invalidate([relPath]);
  deps.invalidateContent([relPath]);
  await settleFile(deps, relPath, doc);
  await deps.refresh('reject-hunk');
  deps.log.activity(
    hunks.length === 1
      ? `Rejected one hunk in ${relPath}.`
      : `Rejected ${hunks.length} hunks in ${relPath}.`,
  );
}

/**
 * Accept one hunk. Nothing on disk changes — the file already contains every
 * hunk. This advances the baseline past this one so it stops being reported and
 * the rest stay pending.
 */
async function acceptHunk(deps: CommandDeps, ref: HunkRef | undefined): Promise<void> {
  if (!ref || !(await requireReady(deps))) return;

  const resolved = await resolveHunk(deps, ref);
  if (!resolved) return;
  await acceptHunks(deps, ref.relPath, resolved.decorated, [resolved.hunk]);
}

/** The accept counterpart of `rejectHunks`, shared by both surfaces. */
async function acceptHunks(
  deps: CommandDeps,
  relPath: string,
  decorated: DecoratedDocument,
  hunks: readonly Hunk[],
): Promise<void> {
  try {
    const advanced = acceptHunksIntoBaseline(decorated.baseline, hunks);
    await deps.store.commitContent(relPath, advanced, `accept hunk in ${relPath}`);
  } catch (err) {
    if (err instanceof HunkStaleError) {
      deps.decorator.invalidate([relPath]);
      vscode.window.showWarningMessage('That change no longer matches the baseline; refreshed.');
      return;
    }
    deps.log.error(`Accept hunk failed: ${String(err)}`);
    vscode.window.showErrorMessage(
      `Could not accept that change: ${describe(err)}. Nothing on disk was modified.`,
    );
    return;
  }

  deps.invalidateContent([relPath]);
  await settleFile(deps, relPath);
  await deps.refresh('accept-hunk');
  deps.log.activity(
    hunks.length === 1
      ? `Accepted one hunk in ${relPath}.`
      : `Accepted ${hunks.length} hunks in ${relPath}.`,
  );
}

// ------------------------------------------------- VS Code's own change peek

/**
 * §7.5.1 surface 2, completed.
 *
 * Clicking a quick-diff gutter bar opens VS Code's inline change widget, which
 * renders every removed line in full — real lines, syntax highlighted, no
 * summary and nothing folded behind a hover. That is the one surface where a
 * deletion can be shown whole, because it uses editor view zones, which reserve
 * real vertical space and are not reachable from an extension.
 *
 * `scm/change/title` puts our Accept and Reject on that widget's title bar, so
 * the place that shows the change completely is also the place you can act on
 * it. VS Code passes the file, the changes it computed, and which one is
 * focused.
 */
async function resolveChange(
  deps: CommandDeps,
  args: unknown[],
): Promise<{ relPath: string; decorated: DecoratedDocument; hunks: Hunk[] } | undefined> {
  const [uri, changes, index] = args as [vscode.Uri?, LineChange[]?, number?];
  if (!uri || !Array.isArray(changes)) return undefined;
  const change = changes[index ?? 0];
  if (!change) return undefined;

  const relPath = relOf(deps.worktree, uri);
  if (!relPath) return undefined;

  const decorated = await deps.decorator.recompute(relPath);
  // VS Code groups changes its own way, so one peeked change can cover several
  // of our finer hunks; all of them go together.
  const hunks = decorated ? hunksCoveredBy(decorated.hunks, change) : [];
  if (!decorated || hunks.length === 0) {
    vscode.window.showWarningMessage('That change is no longer available; the file has moved on.');
    return undefined;
  }
  return { relPath, decorated, hunks };
}

async function rejectChange(deps: CommandDeps, args: unknown[]): Promise<void> {
  if (!(await requireReady(deps))) return;
  const resolved = await resolveChange(deps, args);
  if (!resolved) return;
  await rejectHunks(deps, resolved.relPath, resolved.decorated, resolved.hunks);
}

async function acceptChange(deps: CommandDeps, args: unknown[]): Promise<void> {
  if (!(await requireReady(deps))) return;
  const resolved = await resolveChange(deps, args);
  if (!resolved) return;
  await acceptHunks(deps, resolved.relPath, resolved.decorated, resolved.hunks);
}

/**
 * Closes out a file once its last hunk has been dealt with.
 *
 * Reviewing every hunk has to end where Accept on the whole file ends: nothing
 * left to click, nothing left in the sidebar. Usually it does on its own — no
 * hunks remaining means the baseline now equals the buffer, so git sees nothing.
 *
 * What strands a file is that hunks are computed from the *buffer* while the
 * pending list compares the baseline against *disk*, and the two are not always
 * byte-identical even when nothing is unsaved: VS Code folds mixed line endings
 * to the document's dominant one and hides a byte-order mark, so a baseline
 * synthesized from `getText()` can differ from disk in representation while
 * agreeing on every line. That difference is invisible in the editor and
 * unfixable from it — the file just sits there with no hunks to accept.
 *
 * So: commit the path outright, but only when disk and buffer agree on their
 * actual content. A write that landed during the review changes lines, not just
 * their encoding, so it fails this check and stays pending — Accept must never
 * quietly swallow a change the user has not seen.
 */
async function settleFile(
  deps: CommandDeps,
  relPath: string,
  doc?: vscode.TextDocument,
): Promise<void> {
  const decorated = await deps.decorator.recompute(relPath);
  if (!decorated || decorated.hunks.length > 0) return;

  const document =
    doc ??
    vscode.workspace.textDocuments.find((d) =>
      pathsEqual(d.uri.fsPath, toAbs(deps.worktree, relPath)),
    );
  if (!document || document.isDirty) return;

  try {
    const onDisk = await fs.readFile(document.uri.fsPath, 'utf8');
    if (onDisk === document.getText()) return; // Already settled; git agrees.
    if (!sameTextIgnoringEncoding(onDisk, document.getText())) return;

    await deps.store.commitPaths([relPath], `accept last hunk in ${relPath}`);
    deps.log.debug(`Settled ${relPath}: baseline matched the buffer but not the bytes on disk.`);
  } catch (err) {
    // Accept never writes to disk, so the worst case here is the file staying
    // in the pending list — which the next sweep reports accurately anyway.
    deps.log.debug(`Could not settle ${relPath} after its last hunk: ${String(err)}`);
  }
}


// --------------------------------------------------------------------- accept

/**
 * §8.3 — Accept is pure bookkeeping. It advances the baseline so the file stops
 * being reported, and writes nothing to disk. Ever.
 */
async function acceptCommand(deps: CommandDeps, args: unknown[]): Promise<void> {
  if (!(await requireReady(deps))) return;
  const targets = resolveCommandTargets(deps.worktree, deps.scm, args);
  if (targets.length === 0) return;
  await accept(deps, targets);
}

async function acceptAll(deps: CommandDeps): Promise<void> {
  if (!(await requireReady(deps))) return;
  const targets = deps.scm.current;
  if (targets.length === 0) {
    vscode.window.showInformationMessage('No pending changes to accept.');
    return;
  }
  await accept(deps, targets);
}

async function accept(deps: CommandDeps, targets: FileStatus[]): Promise<void> {
  const relPaths = targets.map((t) => t.relPath);
  try {
    await deps.store.commitPaths(relPaths, `accept (${relPaths.length} file(s))`);
    deps.invalidateContent(relPaths);
    await deps.refresh('accept');
    deps.log.activity(`Accepted ${relPaths.length} file(s).`);
  } catch (err) {
    // E14 — Accept never touched disk, so a failure here is safe by
    // construction: the baseline simply did not advance.
    deps.log.error(`Accept failed: ${String(err)}`);
    vscode.window.showErrorMessage(
      `Could not accept changes: ${describe(err)}. Nothing on disk was modified.`,
    );
  }
}

// --------------------------------------------------------------------- reject

async function rejectCommand(deps: CommandDeps, args: unknown[]): Promise<void> {
  if (!(await requireReady(deps))) return;
  const targets = resolveCommandTargets(deps.worktree, deps.scm, args);
  if (targets.length === 0) return;
  await reject(deps, targets, false);
}

async function rejectAll(deps: CommandDeps): Promise<void> {
  if (!(await requireReady(deps))) return;
  const targets = deps.scm.current;
  if (targets.length === 0) {
    vscode.window.showInformationMessage('No pending changes to reject.');
    return;
  }
  await reject(deps, targets, true);
}

/**
 * §8.4 — Reject overwrites the work tree, so the ordering below is load-bearing:
 * suppress *before* writing, restore, prune, then reconcile the open buffers.
 */
async function reject(deps: CommandDeps, targets: FileStatus[], isRejectAll: boolean): Promise<void> {
  const relPaths = targets.map((t) => t.relPath);
  const absPaths = relPaths.map((rel) => toAbs(deps.worktree, rel));

  if (!(await confirmReject(deps, targets, isRejectAll))) return;

  // §6.6 step 5, and it is not optional: our own restore write trips the
  // watcher. Without pre-arming a suppression entry the extension classifies
  // its own revert as a fresh external write and immediately re-lists the file
  // it just restored.
  deps.detector.suppressPaths(absPaths);
  for (const abs of absPaths) deps.detector.forgetPending(abs);

  // Capture dirty documents before the disk changes underneath them.
  const dirtyDocs = vscode.workspace.textDocuments.filter(
    (doc) => doc.isDirty && relPaths.includes(relOf(deps.worktree, doc.uri) ?? ''),
  );

  try {
    const outcome = await deps.store.restore(relPaths);

    // §8.4 — a clean buffer reloads from disk on its own; a dirty one does not,
    // and would overwrite our restore on its next save.
    for (const doc of dirtyDocs) {
      const rel = relOf(deps.worktree, doc.uri);
      if (!rel) continue;
      const status = targets.find((t) => t.relPath === rel)?.status;
      if (status === 'A') continue; // the file is gone; nothing to revert to
      await forceRevertBuffer(deps, doc);
    }

    deps.invalidateContent(relPaths);
    await deps.refresh('reject');

    if (outcome.prunedDirs.length > 0) {
      deps.log.info(`Pruned ${outcome.prunedDirs.length} empty directory(ies) after reject.`);
    }
    deps.log.activity(
      `Rejected ${outcome.restored.length} file(s)` +
        (outcome.failures.length ? `, ${outcome.failures.length} failed` : '') +
        '.',
    );

    // E13 — per-file failures are reported, never swallowed.
    if (outcome.failures.length > 0) {
      const first = outcome.failures[0];
      vscode.window.showWarningMessage(
        outcome.failures.length === 1
          ? `Could not restore ${first.relPath}: ${first.message}`
          : `Could not restore ${outcome.failures.length} of ${relPaths.length} files. First failure: ${first.relPath} — ${first.message}`,
        'Show Log',
      ).then((choice) => {
        if (choice === 'Show Log') deps.showLog();
      });
    }
  } catch (err) {
    deps.log.error(`Reject failed: ${String(err)}`);
    vscode.window.showErrorMessage(`Could not reject changes: ${describe(err)}`);
    await deps.refresh('reject-failed');
  }
}

/**
 * §4.5 — Reject is destructive and not reliably undoable, but requiring
 * confirmation on *every* reject just trains the user to click through. So:
 * Reject All always, unsaved buffers always, deleting an added file always;
 * a single clean modified file, never.
 */
async function confirmReject(
  deps: CommandDeps,
  targets: FileStatus[],
  isRejectAll: boolean,
): Promise<boolean> {
  const mode = deps.config().confirmReject;
  if (mode === 'never') return true;

  const dirty = targets.filter((t) => isOpenAndDirty(deps.worktree, t.relPath));
  const added = targets.filter((t) => t.status === 'A');

  const needsConfirm =
    mode === 'always' || isRejectAll || dirty.length > 0 || added.length > 0;
  if (!needsConfirm) return true;

  const lines: string[] = [];
  if (isRejectAll) {
    lines.push(`Reject all ${targets.length} pending change(s)?`);
  } else if (targets.length === 1) {
    lines.push(`Reject changes to ${targets[0].relPath}?`);
  } else {
    lines.push(`Reject ${targets.length} pending change(s)?`);
  }
  lines.push('Files on disk will be overwritten with their baseline content.');

  if (added.length > 0) {
    lines.push(
      added.length === 1
        ? `${added[0].relPath} was created after the baseline and will be deleted.`
        : `${added.length} file(s) were created after the baseline and will be deleted.`,
    );
  }
  if (dirty.length > 0) {
    // Must say so explicitly (§4.5): this is the user's own in-buffer work.
    lines.push(
      dirty.length === 1
        ? `${dirty[0].relPath} has unsaved changes in the editor. Your unsaved work will be discarded.`
        : `${dirty.length} file(s) have unsaved changes in the editor. That unsaved work will be discarded.`,
    );
  }

  const choice = await vscode.window.showWarningMessage(
    lines[0],
    { modal: true, detail: lines.slice(1).join('\n\n') },
    'Reject',
  );
  return choice === 'Reject';
}

/**
 * §8.4 — when a document is clean, VS Code reloads it from disk automatically
 * after an external write. When it is dirty it detects the conflict and refuses,
 * leaving a stale buffer that would overwrite our restore on the next save.
 *
 * `workbench.action.files.revert` only ever targets the *active* editor, so
 * using it would mean stealing focus for every file in a bulk reject. Replacing
 * the document's content with what is now on disk and saving achieves the same
 * end without focus changes — and leaves one undo entry, so Cmd+Z gives the
 * user their unsaved work back.
 */
async function forceRevertBuffer(deps: CommandDeps, doc: vscode.TextDocument): Promise<void> {
  const rel = relOf(deps.worktree, doc.uri);
  if (!rel) return;
  try {
    const onDisk = await fs.readFile(doc.uri.fsPath, 'utf8');
    if (doc.getText() === onDisk) return;

    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(
      doc.positionAt(0),
      doc.positionAt(doc.getText().length),
    );
    edit.replace(doc.uri, fullRange, onDisk);
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      deps.log.warn(`Could not revert buffer for ${rel}; it may still hold stale content.`);
      return;
    }
    // Saving writes identical bytes, so the file does not really change — but
    // it does clear the dirty flag, which is the point.
    deps.detector.suppressPath(doc.uri.fsPath);
    await doc.save();
  } catch (err) {
    deps.log.warn(`forceRevertBuffer failed for ${rel}: ${String(err)}`);
  }
}

// ----------------------------------------------------------------------- diff

async function openDiff(
  deps: CommandDeps,
  args: unknown[],
  mode: LfctConfig['diffView'],
): Promise<void> {
  const targets = resolveCommandTargets(deps.worktree, deps.scm, args);
  // Invoked from the command palette or a keybinding there is no argument at
  // all, so fall back to whatever file is in front of the user. This is what
  // makes the diff reachable from a file opened through the Explorer rather
  // than from the pending list.
  const target = targets[0] ?? activeFileTarget(deps);
  if (!target) {
    if (args.length === 0) {
      vscode.window.showInformationMessage(
        'No pending changes in the active file. Files an external process changed appear under AI Changes.',
      );
    }
    return;
  }

  try {
    if (mode === 'liveFile') {
      await openLiveFile(deps, target);
    } else if (mode === 'patch') {
      await openInlinePatch(target);
    } else {
      await openSideBySide(deps, target);
    }
  } catch (err) {
    deps.log.error(`Could not open diff for ${target.relPath}: ${String(err)}`);
    vscode.window.showErrorMessage(`Could not open changes for ${target.relPath}: ${describe(err)}`);
  }
}

/**
 * The default click action: open the real, editable file with the agent's
 * changes highlighted in place and per-hunk controls attached.
 *
 * A deleted file has nothing to open, and an added file has no baseline to
 * compare against, so both fall back to the read-only patch view.
 */
async function openLiveFile(deps: CommandDeps, target: FileStatus): Promise<void> {
  if (target.status === 'D' || target.status === 'A') {
    await openInlinePatch(target);
    return;
  }
  const uri = vscode.Uri.file(toAbs(deps.worktree, target.relPath));
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc, { preview: false });

  // Jump to the first change so a long file does not open at the top with the
  // agent's edit somewhere off screen. `invalidate` only schedules a recompute,
  // so this has to await one — otherwise the first open reads whatever the
  // previous sweep left behind, which for a freshly opened file is nothing.
  const decorated = await deps.decorator.recompute(target.relPath);
  const firstHunk = decorated?.hunks[0];
  if (firstHunk) {
    const line = Math.min(firstHunk.anchorLine, Math.max(doc.lineCount - 1, 0));
    const range = new vscode.Range(line, 0, line, 0);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    editor.selection = new vscode.Selection(range.start, range.start);
  }
}

/** The active editor's file, if it is one the pending list is reporting. */
function activeFileTarget(deps: CommandDeps): FileStatus | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') return undefined;
  const relPath = relOf(deps.worktree, editor.document.uri);
  if (!relPath) return undefined;
  const status = deps.scm.statusOf(relPath);
  return status ? { relPath, status } : undefined;
}

/** The read-only unified patch, still available on demand. */
async function openInlinePatch(target: FileStatus): Promise<void> {
  const uri = patchUri(target.relPath, target.status);
  const doc = await vscode.workspace.openTextDocument(uri);

  // The URI keeps the file's own extension, so VS Code has already resolved the
  // file's own grammar and the diff is highlighted as the language it is.
  // Languages whose validators would try to analyse a document holding two
  // interleaved versions of a file get swapped to an alias that has the same
  // grammar and no server; see `patchLanguageFor`.
  const alias = patchLanguageFor(doc.languageId);
  if (alias) await vscode.languages.setTextDocumentLanguage(doc, alias);

  await vscode.window.showTextDocument(doc, { preview: true });
}

/** §7.5.1 surface 3 — the native two-pane editor, on demand. */
async function openSideBySide(deps: CommandDeps, target: FileStatus): Promise<void> {
  const left = baselineUri(target.relPath);
  const right =
    target.status === 'D'
      ? emptyUri(target.relPath)
      : vscode.Uri.file(toAbs(deps.worktree, target.relPath));
  const title = `${target.relPath} (baseline ↔ current)`;
  await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
}

const DIFF_VIEW_CYCLE: LfctConfig['diffView'][] = ['liveFile', 'patch', 'sideBySide'];
const DIFF_VIEW_LABEL: Record<LfctConfig['diffView'], string> = {
  liveFile: 'Changes now open in the real file, with per-hunk controls.',
  patch: 'Changes now open as a read-only unified patch.',
  sideBySide: 'Changes now open in the side-by-side diff editor.',
};

async function toggleDiffView(deps: CommandDeps): Promise<void> {
  const current = deps.config().diffView;
  const next = DIFF_VIEW_CYCLE[(DIFF_VIEW_CYCLE.indexOf(current) + 1) % DIFF_VIEW_CYCLE.length];
  await vscode.workspace
    .getConfiguration('lfct')
    .update('diffView', next, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(DIFF_VIEW_LABEL[next]);
}

// -------------------------------------------------------------------- storage

async function revealStorage(deps: CommandDeps): Promise<void> {
  const uri = vscode.Uri.file(deps.storagePath);
  await vscode.commands.executeCommand('revealFileInOS', uri);
}

/**
 * §9.3 — `workspaceStorage` is keyed by workspace path, so moving or renaming a
 * project orphans its baselines and silently starts fresh. VS Code garbage
 * collects that directory eventually, but not reliably, and §S2 makes deletion
 * the documented remediation for `.env` history.
 */
async function listStores(deps: CommandDeps): Promise<void> {
  const workspaceStorageRoot = path.dirname(path.dirname(deps.storagePath));
  const extensionDirName = path.basename(deps.storagePath);

  const stores = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Scanning checkpoint storage…' },
    () => collectStores(workspaceStorageRoot, extensionDirName),
  );

  if (stores.length === 0) {
    vscode.window.showInformationMessage('No checkpoint stores found.');
    return;
  }

  const items = stores.map((s) => ({
    label: s.exists ? path.basename(s.worktreePath) : '(missing workspace)',
    description: formatBytes(s.sizeBytes),
    detail:
      `${s.worktreePath}${s.exists ? '' : '  — workspace no longer exists'}` +
      (s.lastAcceptAt ? `  ·  last accept ${new Date(s.lastAcceptAt).toLocaleString()}` : '') +
      (s.isCurrent ? '  ·  current workspace' : ''),
    store: s,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Checkpoint Storage',
    placeHolder: 'Select a store to delete it. Baselines are kept indefinitely.',
  });
  if (!picked) return;

  const confirm = await vscode.window.showWarningMessage(
    `Delete the checkpoint store for ${picked.store.worktreePath}?`,
    {
      modal: true,
      detail:
        'All baselines and history for that workspace are removed permanently, ' +
        'including any tracked contents of .env and similar files. ' +
        (picked.store.isCurrent
          ? 'This is the current workspace: a fresh baseline will be built on the next window reload.'
          : ''),
    },
    'Delete',
  );
  if (confirm !== 'Delete') return;

  try {
    await fs.rm(picked.store.storagePath, { recursive: true, force: true });
    vscode.window.showInformationMessage(
      `Deleted checkpoint store (${formatBytes(picked.store.sizeBytes)}).`,
    );
    deps.log.activity(`Deleted checkpoint store at ${picked.store.storagePath}`);
  } catch (err) {
    vscode.window.showErrorMessage(`Could not delete store: ${describe(err)}`);
  }
}

interface StoreSummary {
  storagePath: string;
  worktreePath: string;
  sizeBytes: number;
  lastAcceptAt: string | null;
  exists: boolean;
  isCurrent: boolean;
}

async function collectStores(
  workspaceStorageRoot: string,
  extensionDirName: string,
): Promise<StoreSummary[]> {
  let hashes: string[];
  try {
    hashes = await fs.readdir(workspaceStorageRoot);
  } catch {
    return [];
  }

  const out: StoreSummary[] = [];
  for (const hash of hashes) {
    const storagePath = path.join(workspaceStorageRoot, hash, extensionDirName);
    let meta: StoreMeta;
    try {
      meta = JSON.parse(await fs.readFile(path.join(storagePath, META_FILE_NAME), 'utf8'));
    } catch {
      continue;
    }
    out.push({
      storagePath,
      worktreePath: meta.worktreePath,
      sizeBytes: await directorySize(path.join(storagePath, SHADOW_DIR_NAME)),
      lastAcceptAt: meta.lastAcceptAt,
      exists: await pathExists(meta.worktreePath),
      isCurrent: false,
    });
  }
  out.sort((a, b) => b.sizeBytes - a.sizeBytes);
  return out;
}

async function directorySize(dir: string): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
      } else if (entry.isFile()) {
        try {
          total += (await fs.stat(abs)).size;
        } catch {
          /* vanished mid-scan */
        }
      }
    }
  }
  return total;
}

// ---------------------------------------------------------------------- utils

/**
 * §8.1 — rejecting against a half-built baseline restores a file to content
 * that was never real, so every mutating command is gated on readiness.
 */
async function requireReady(deps: CommandDeps): Promise<boolean> {
  if (deps.isReady()) return true;
  vscode.window.showWarningMessage(
    'AI Undo is still building the initial baseline. Try again in a moment.',
  );
  return false;
}

function isOpenAndDirty(worktree: string, relPath: string): boolean {
  const abs = toAbs(worktree, relPath);
  return vscode.workspace.textDocuments.some(
    (doc) => doc.isDirty && doc.uri.scheme === 'file' && pathsEqual(doc.uri.fsPath, abs),
  );
}

function relOf(worktree: string, uri: vscode.Uri): string | undefined {
  if (uri.scheme !== 'file') return undefined;
  const rel = path.relative(worktree, uri.fsPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep).join('/');
}

function pathsEqual(a: string, b: string): boolean {
  const normalize = (p: string) =>
    process.platform === 'darwin' || process.platform === 'win32'
      ? path.resolve(p).toLowerCase()
      : path.resolve(p);
  return normalize(a) === normalize(b);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type { FileStatusCode };
