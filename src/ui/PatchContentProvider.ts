import * as vscode from 'vscode';

import type { Logger } from '../log';
import type { CheckpointStore, FileStatusCode } from '../store/CheckpointStore';
import { formatPatchForDisplay, type PatchLine } from './patchFormat';
import { patchUri, relPathFromPatchUri, statusFromPatchUri } from './uris';

/**
 * §7.5.1 — the inline unified diff, and the reason it exists.
 *
 * G9 requires one column with additions and deletions interleaved. VS Code
 * exposes no per-editor API to open its diff editor in inline mode: rendering
 * is governed by the global `diffEditor.renderSideBySide` setting, and
 * `vscode.diff` accepts only `TextDocumentShowOptions`. Flipping that global on
 * the user's behalf would silently change every diff they open, including
 * Git's — not acceptable.
 *
 * So we render the unified view ourselves, as a read-only virtual document
 * whose `.diff` extension picks up VS Code's built-in diff grammar. No webview,
 * no custom rendering, no dependency.
 */
export class PatchContentProvider
  implements vscode.TextDocumentContentProvider, vscode.Disposable
{
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changeEmitter.event;

  /** Remembers each path's status so a refresh can regenerate the right patch. */
  private readonly lastStatus = new Map<string, FileStatusCode>();
  /**
   * Per-line kind and number for the last content served for each patch URI,
   * so `PatchDecorator` can draw the change and the margin. Held here because a
   * `TextDocumentContentProvider` may only return a string, and the text itself
   * deliberately no longer carries `+`/`-` prefixes.
   */
  private readonly patchLines = new Map<string, PatchLine[]>();

  constructor(
    private readonly store: CheckpointStore,
    private readonly log: Logger,
  ) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const relPath = relPathFromPatchUri(uri);
    const status = statusFromPatchUri(uri);
    this.lastStatus.set(relPath, status);
    try {
      // The store hands back a real, apply-able patch; the reader only needs
      // the change. See `formatPatchForDisplay`.
      const formatted = formatPatchForDisplay(await this.store.readPatch(relPath, status));
      this.patchLines.set(uri.toString(), formatted.lines);
      return formatted.text;
    } catch (err) {
      this.log.error(`Failed to build patch for ${relPath}: ${String(err)}`);
      return `# Failed to generate a diff for ${relPath}\n# ${String(err)}\n`;
    }
  }

  /** Per-line kind and number for a patch document, for `PatchDecorator`. */
  linesFor(uri: vscode.Uri): PatchLine[] | undefined {
    return this.patchLines.get(uri.toString());
  }

  /**
   * §7.5.1 — fire on **both** providers after Accept and Reject, or open patch
   * views go stale showing changes that no longer exist.
   */
  fireChange(relPaths: readonly string[]): void {
    for (const relPath of relPaths) {
      const status = this.lastStatus.get(relPath);
      if (status) this.changeEmitter.fire(patchUri(relPath, status));
      // Also nudge the other two spellings; a path can change status between
      // opening the view and acting on it.
      for (const s of ['M', 'A', 'D'] as FileStatusCode[]) {
        if (s !== status) this.changeEmitter.fire(patchUri(relPath, s));
      }
    }
  }

  dispose(): void {
    this.changeEmitter.dispose();
    this.lastStatus.clear();
    this.patchLines.clear();
  }
}
