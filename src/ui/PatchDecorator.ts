import * as vscode from 'vscode';

import type { PatchLine } from './patchFormat';
import { PATCH_SCHEME } from './uris';

/**
 * Rendering for the unified patch view (§7.5.1 surface 1): full-line
 * backgrounds, and real line numbers in the margin.
 *
 * The `.diff` grammar only colors the *text* of a changed line, which reads as
 * a faint tint on a long line and vanishes entirely on one that is mostly
 * whitespace. A background block makes the shape of a change legible at a
 * glance, which is what the eye actually scans for. Colors come from the
 * theme's own diff tokens rather than fixed rgba, so this follows whatever
 * theme is active instead of fighting it.
 *
 * The numbers are `before` attachments, not text. That keeps every line
 * starting with `+`, `-` or a space — so the grammar still colors it — and
 * keeps them out of the clipboard when the user copies a line of code.
 */

/** Figure space: one digit wide, and it does not collapse when rendered inline. */
const PAD = '\u2007';

/** Patches past this are not worth the main-thread pass; they are already unreadable. */
const MAX_DECORATED_LINES = 20_000;

export type PatchLineLookup = (uri: vscode.Uri) => PatchLine[] | undefined;

export class PatchDecorator implements vscode.Disposable {
  private readonly added: vscode.TextEditorDecorationType;
  private readonly removed: vscode.TextEditorDecorationType;
  private readonly gutter: vscode.TextEditorDecorationType;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly linesFor: PatchLineLookup) {
    this.added = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });

    this.removed = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('diffEditor.removedLineBackground'),
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });

    this.gutter = vscode.window.createTextEditorDecorationType({
      before: {
        color: new vscode.ThemeColor('editorLineNumber.foreground'),
        margin: '0 1.25em 0 0',
      },
    });

    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors(() => this.refresh()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.scheme === PATCH_SCHEME) this.refresh();
      }),
    );
    this.refresh();
  }

  refresh(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.scheme !== PATCH_SCHEME) continue;
      this.decorate(editor);
    }
  }

  private decorate(editor: vscode.TextEditor): void {
    const document = editor.document;
    if (document.lineCount > MAX_DECORATED_LINES) {
      this.clear(editor);
      return;
    }

    // The editor's own gutter would number the *patch* 1, 2, 3… next to the
    // real numbers we render, which is worse than showing neither. This is a
    // per-editor option, so no global setting is touched.
    editor.options = { lineNumbers: vscode.TextEditorLineNumbersStyle.Off };

    // The change kind comes from the formatter, not from the text: the `+`/`-`
    // prefixes are gone so the file's own grammar can highlight the lines.
    const meta = this.linesFor(document.uri);
    const width = meta ? widestNumber(meta) : 0;

    const added: vscode.Range[] = [];
    const removed: vscode.Range[] = [];
    const gutter: vscode.DecorationOptions[] = [];

    for (let i = 0; i < document.lineCount; i++) {
      const line = document.lineAt(i);
      const info = meta?.[i];
      if (info?.kind === 'added') added.push(line.range);
      else if (info?.kind === 'removed') removed.push(line.range);

      const number = info?.number;
      if (info && typeof number === 'number') {
        gutter.push({
          range: line.range,
          // The pad and separator are figure spaces (U+2007): exactly one
          // digit wide, and they do not collapse the way a plain space does in
          // the inline rendering VS Code uses for decoration attachments.
          renderOptions: { before: { contentText: gutterText(number, width, info.kind) } },
        });
      }
    }

    editor.setDecorations(this.added, added);
    editor.setDecorations(this.removed, removed);
    editor.setDecorations(this.gutter, gutter);
  }

  private clear(editor: vscode.TextEditor): void {
    editor.setDecorations(this.added, []);
    editor.setDecorations(this.removed, []);
    editor.setDecorations(this.gutter, []);
  }

  dispose(): void {
    this.added.dispose();
    this.removed.dispose();
    this.gutter.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

/** Digits in the largest number, so every line's number occupies one column. */
function widestNumber(lines: readonly PatchLine[]): number {
  let widest = 1;
  for (const { number } of lines) {
    if (typeof number === 'number') widest = Math.max(widest, String(number).length);
  }
  return widest;
}

/**
 * The margin: right-aligned number, then the change sign.
 *
 * The sign is redundant with the background color and deliberately so — it is
 * what keeps the view readable for anyone who cannot rely on the red/green
 * distinction, and it survives being screenshotted or copied into a terminal.
 */
function gutterText(number: number, width: number, kind: PatchLine['kind']): string {
  const sign = kind === 'added' ? '+' : kind === 'removed' ? '-' : PAD;
  return `${String(number).padStart(width, PAD)}${PAD}${sign}`;
}
