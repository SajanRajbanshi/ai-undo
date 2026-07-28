import * as vscode from 'vscode';

import { computeHunks, hunkStats, type Hunk } from '../diff/hunks';
import type { Logger } from '../log';
import type { CheckpointStore } from '../store/CheckpointStore';
import { isBinary } from '../store/patch';
import { toRelPosix } from '../util/paths';

/**
 * The live inline diff: renders an agent's changes inside the real, editable
 * file rather than in a separate read-only tab.
 *
 * **The one thing VS Code cannot do.** Added and modified lines exist in the
 * buffer, so they get full-width background blocks exactly like Cursor's.
 * *Deleted* lines do not exist in the buffer, and no extension API can insert
 * phantom lines into a document — `contentText` attachments are single-line, and
 * genuinely inserting the text would make the buffer dirty and risk writing the
 * removed lines back to disk, which is the one failure this extension must never
 * have. So deletions are shown as a red marker on the adjacent line, labelled
 * with the removed content and carrying the full block in a syntax-highlighted
 * hover.
 */

/** Recompute at most this often while the user is typing. */
const DEBOUNCE_MS = 200;
/** Files past this size are skipped; the diff is not worth the main-thread time. */
const MAX_DECORATED_LINES = 20_000;
/** Deleted-line preview text is truncated to this. */
const PREVIEW_CHARS = 72;

export interface DecoratedDocument {
  relPath: string;
  hunks: Hunk[];
  baseline: string;
  documentVersion: number;
}

export class InlineDiffDecorator implements vscode.Disposable {
  private readonly addedLine: vscode.TextEditorDecorationType;
  private readonly addedGutter: vscode.TextEditorDecorationType;
  private readonly deletionMarker: vscode.TextEditorDecorationType;

  private readonly disposables: vscode.Disposable[] = [];
  private readonly baselineCache = new Map<string, string | null>();
  /** Latest computed hunks per document, consumed by the CodeLens provider. */
  private readonly current = new Map<string, DecoratedDocument>();
  private debounce: NodeJS.Timeout | undefined;

  private readonly changeEmitter = new vscode.EventEmitter<void>();
  /** Fires when hunks changed, so CodeLenses can refresh. */
  readonly onDidChangeHunks = this.changeEmitter.event;

  constructor(
    private readonly worktree: string,
    private readonly store: CheckpointStore,
    private readonly isPending: (relPath: string) => boolean,
    private readonly log: Logger,
  ) {
    // Explicit colors rather than the `diffEditor.*` theme tokens: those are
    // tuned for the two-pane editor and read as a faint wash in a normal
    // editor, which was the complaint that prompted this surface.
    this.addedLine = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      light: { backgroundColor: 'rgba(46, 160, 67, 0.16)' },
      dark: { backgroundColor: 'rgba(63, 185, 80, 0.16)' },
      overviewRulerColor: 'rgba(63, 185, 80, 0.75)',
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });

    this.addedGutter = vscode.window.createTextEditorDecorationType({
      isWholeLine: false,
      light: { borderColor: 'rgba(46, 160, 67, 0.9)' },
      dark: { borderColor: 'rgba(63, 185, 80, 0.9)' },
      borderWidth: '0 0 0 3px',
      borderStyle: 'solid',
    });

    this.deletionMarker = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      light: { backgroundColor: 'rgba(248, 81, 73, 0.10)' },
      dark: { backgroundColor: 'rgba(248, 81, 73, 0.12)' },
      overviewRulerColor: 'rgba(248, 81, 73, 0.75)',
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      after: {
        margin: '0 0 0 1.5rem',
        fontStyle: 'italic',
        color: new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),
      },
    });

    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors(() => this.schedule()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (this.relPathOf(e.document) !== undefined) this.schedule();
      }),
    );
  }

  /** Hunks for a document, for the CodeLens provider and hunk commands. */
  hunksFor(relPath: string): DecoratedDocument | undefined {
    return this.current.get(relPath);
  }

  /**
   * Recompute one document now, against whatever the baseline is at this
   * instant, and hand the result back.
   *
   * `invalidate` only *schedules* a recompute, so between an Accept committing a
   * new baseline and the timer firing, `hunksFor` still answers with hunks
   * measured against the previous one. Accepting a second hunk off that stale
   * snapshot writes a baseline that never contains the first — which is why
   * accepting hunks one by one could leave a file in the pending list forever.
   * The per-hunk commands call this first so they always act on live data.
   */
  async recompute(relPath: string): Promise<DecoratedDocument | undefined> {
    this.baselineCache.delete(relPath);

    const document = vscode.workspace.textDocuments.find(
      (doc) => this.relPathOf(doc) === relPath,
    );
    if (!document) return undefined;

    // The same ceiling `decorate` enforces, and for the same reason: a diff of
    // this size costs real main-thread time. Skipping it here would also make
    // the two paths disagree — this one would publish hunks that the next
    // debounced sweep immediately dropped, so the controls would appear and
    // then vanish on their own.
    if (document.lineCount > MAX_DECORATED_LINES) {
      this.current.delete(relPath);
      return undefined;
    }

    const baseline = await this.baselineOf(relPath);
    if (baseline === null) {
      this.current.delete(relPath);
      return undefined;
    }

    const decorated: DecoratedDocument = {
      relPath,
      hunks: computeHunks(baseline, document.getText()),
      baseline,
      documentVersion: document.version,
    };
    this.current.set(relPath, decorated);

    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document === document) this.applyDecorations(editor, decorated.hunks);
    }
    this.changeEmitter.fire();
    return decorated;
  }

  /** Drops cached baselines after Accept or Reject moved them. */
  invalidate(relPaths?: readonly string[]): void {
    if (relPaths) {
      for (const rel of relPaths) this.baselineCache.delete(rel);
    } else {
      this.baselineCache.clear();
    }
    this.schedule(0);
  }

  private schedule(delay = DEBOUNCE_MS): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      void this.refreshAll();
    }, delay);
  }

  private async refreshAll(): Promise<void> {
    const seen = new Set<string>();
    for (const editor of vscode.window.visibleTextEditors) {
      const relPath = this.relPathOf(editor.document);
      if (relPath === undefined) continue;
      seen.add(relPath);
      try {
        await this.decorate(editor, relPath);
      } catch (err) {
        this.log.debug(`Inline diff failed for ${relPath}: ${String(err)}`);
        this.clear(editor);
      }
    }
    for (const key of [...this.current.keys()]) {
      if (!seen.has(key)) this.current.delete(key);
    }
    this.changeEmitter.fire();
  }

  private async decorate(editor: vscode.TextEditor, relPath: string): Promise<void> {
    // Only files the SCM view is actually reporting get decorated. Everything
    // else is identical to its baseline, so there would be nothing to draw.
    if (!this.isPending(relPath)) {
      this.clear(editor);
      this.current.delete(relPath);
      return;
    }
    if (editor.document.lineCount > MAX_DECORATED_LINES) {
      this.clear(editor);
      this.current.delete(relPath);
      return;
    }

    const baseline = await this.baselineOf(relPath);
    if (baseline === null) {
      // Not in the baseline at all — the agent created it. Marking every line
      // as added would be technically true and visually useless.
      this.clear(editor);
      this.current.delete(relPath);
      return;
    }

    const currentText = editor.document.getText();
    const hunks = computeHunks(baseline, currentText);
    this.current.set(relPath, {
      relPath,
      hunks,
      baseline,
      documentVersion: editor.document.version,
    });

    this.applyDecorations(editor, hunks);

    const totals = hunks.reduce(
      (acc, h) => {
        const s = hunkStats(h);
        return { added: acc.added + s.added, removed: acc.removed + s.removed };
      },
      { added: 0, removed: 0 },
    );
    this.log.debug(
      `Inline diff for ${relPath}: ${hunks.length} hunk(s), +${totals.added} -${totals.removed}`,
    );
  }

  /**
   * Paints one editor from a set of hunks. Shared by the debounced sweep and by
   * `recompute`, so a per-hunk command's immediate repaint can never disagree
   * with the one the sweep would have produced.
   */
  private applyDecorations(editor: vscode.TextEditor, hunks: readonly Hunk[]): void {
    const addedRanges: vscode.Range[] = [];
    for (const hunk of hunks) {
      for (const line of hunk.addedLines) {
        if (line < editor.document.lineCount) {
          addedRanges.push(editor.document.lineAt(line).range);
        }
      }
    }

    // `markerLine` is already unique per document, but it can still be clamped
    // back into collision on a file too short to hold it — a one-line file with
    // a block removed above it *and* below it has exactly one line to draw on.
    // Grouping by the final line means the second block is folded into the first
    // marker instead of silently overwriting it.
    const byLine = new Map<number, Hunk['deletions']>();
    if (editor.document.lineCount > 0) {
      const lastLine = Math.max(editor.document.lineCount - 1, 0);
      for (const hunk of hunks) {
        for (const group of hunk.deletions) {
          const anchor = Math.min(Math.max(group.markerLine, 0), lastLine);
          const existing = byLine.get(anchor);
          if (existing) existing.push(group);
          else byLine.set(anchor, [group]);
        }
      }
    }

    const deletionRanges: vscode.DecorationOptions[] = [];
    for (const [anchor, groups] of byLine) {
      const blocks = groups.map((g) => g.lines);
      deletionRanges.push({
        range: editor.document.lineAt(anchor).range,
        hoverMessage: this.deletionHover(blocks, editor.document.languageId),
        renderOptions: {
          after: { contentText: this.deletionLabel(blocks) },
        },
      });
    }

    editor.setDecorations(this.addedLine, addedRanges);
    editor.setDecorations(this.addedGutter, addedRanges);
    editor.setDecorations(this.deletionMarker, deletionRanges);
  }

  /**
   * The single line of text VS Code will let us put here.
   *
   * A decoration attachment cannot contain a newline — `contentText` ignores
   * them — so a nine-line deletion has to be summarized in one line. The old
   * wording put the first removed line next to "(9 lines removed)", which reads
   * as a contradiction: one line of code, labelled nine. Saying "+8 more" makes
   * it plain that what is shown is the first of several, and names the hover as
   * the way to see the rest.
   */
  private deletionLabel(blocks: readonly (readonly string[])[]): string {
    const total = blocks.reduce((n, b) => n + b.length, 0);
    const first = blocks[0]?.[0]?.trim() ?? '';
    const truncated =
      first.length > PREVIEW_CHARS ? first.slice(0, PREVIEW_CHARS - 1) + '…' : first;
    if (total === 1) return `  −  ${truncated}`;
    return `  −  ${truncated}   +${total - 1} more removed (hover)`;
  }

  private deletionHover(
    blocks: readonly (readonly string[])[],
    languageId: string,
  ): vscode.MarkdownString {
    const total = blocks.reduce((n, b) => n + b.length, 0);
    const md = new vscode.MarkdownString();
    md.appendMarkdown(
      `**${total} line${total === 1 ? '' : 's'} removed by an external process**\n\n`,
    );
    for (const [i, block] of blocks.entries()) {
      // Only reachable where two removed blocks had to share one marker line.
      if (blocks.length > 1) md.appendMarkdown(`Block ${i + 1} of ${blocks.length}:\n\n`);
      md.appendCodeblock(block.join('\n'), languageId);
    }
    md.isTrusted = false;
    return md;
  }

  private async baselineOf(relPath: string): Promise<string | null> {
    const cached = this.baselineCache.get(relPath);
    if (cached !== undefined) return cached;

    const bytes = await this.store.readBaseline(relPath);
    // Binary content has no line structure to diff.
    const text = bytes === null || isBinary(bytes) ? null : Buffer.from(bytes).toString('utf8');
    this.baselineCache.set(relPath, text);
    return text;
  }

  private relPathOf(document: vscode.TextDocument): string | undefined {
    if (document.uri.scheme !== 'file') return undefined;
    return toRelPosix(this.worktree, document.uri.fsPath);
  }

  private clear(editor: vscode.TextEditor): void {
    editor.setDecorations(this.addedLine, []);
    editor.setDecorations(this.addedGutter, []);
    editor.setDecorations(this.deletionMarker, []);
  }

  dispose(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.addedLine.dispose();
    this.addedGutter.dispose();
    this.deletionMarker.dispose();
    this.changeEmitter.dispose();
    for (const d of this.disposables) d.dispose();
    this.current.clear();
    this.baselineCache.clear();
  }
}
