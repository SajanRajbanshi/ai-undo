import * as vscode from 'vscode';

import { hunkStats } from '../diff/hunks';
import { toRelPosix } from '../util/paths';
import type { InlineDiffDecorator } from './InlineDiffDecorator';

/**
 * Per-hunk Accept and Reject, rendered as CodeLenses above each hunk in the
 * real editor.
 *
 * §16 specifies CodeLens **in the normal editor** rather than in the diff
 * editor, because VS Code exposes no API for accept/reject affordances inside
 * its diff editor and CodeLens rendering there is inconsistent. That constraint
 * is what makes the live-file surface the right home for this.
 *
 * The two actions are not mirror images, which is worth understanding:
 *
 *  - **Reject** splices the baseline's lines back into the buffer. It changes
 *    what is on disk. It is the real action.
 *  - **Accept** moves the baseline forward by exactly this hunk. The file on
 *    disk already contains every hunk, so nothing is written — the hunk simply
 *    stops being reported and the rest stay pending.
 */
export class HunkCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changeEmitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly worktree: string,
    private readonly decorator: InlineDiffDecorator,
    private readonly enabled: () => boolean,
  ) {
    this.disposables.push(decorator.onDidChangeHunks(() => this.changeEmitter.fire()));
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.enabled()) return [];
    if (document.uri.scheme !== 'file') return [];

    const relPath = toRelPosix(this.worktree, document.uri.fsPath);
    if (relPath === undefined) return [];

    const decorated = this.decorator.hunksFor(relPath);
    if (!decorated || decorated.hunks.length === 0) return [];
    // Stale hunks would point at the wrong lines; the decorator will recompute
    // and fire onDidChangeHunks in a moment.
    if (decorated.documentVersion !== document.version) return [];

    const lenses: vscode.CodeLens[] = [];
    for (const hunk of decorated.hunks) {
      const line = Math.min(hunk.anchorLine, Math.max(document.lineCount - 1, 0));
      const range = new vscode.Range(line, 0, line, 0);
      const { added, removed } = hunkStats(hunk);
      // By id, never by index: an Accept renumbers every remaining hunk, and
      // these lenses may still be the ones painted before that happened.
      const args = [{ relPath, hunkId: hunk.id }];

      lenses.push(
        new vscode.CodeLens(range, {
          title: '$(discard) Reject',
          tooltip: `${describeChange(added, removed)} — put the baseline back here`,
          command: 'lfct.rejectHunk',
          arguments: args,
        }),
        new vscode.CodeLens(range, {
          title: '$(check) Keep',
          tooltip: `${describeChange(added, removed)} — advance the baseline past it. Nothing on disk changes.`,
          command: 'lfct.acceptHunk',
          arguments: args,
        }),
        new vscode.CodeLens(range, {
          title: `+${added} −${removed}`,
          command: '',
        }),
      );
    }
    return lenses;
  }

  refresh(): void {
    this.changeEmitter.fire();
  }

  dispose(): void {
    this.changeEmitter.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

/**
 * A deletion-only hunk now gets its own controls, so the tooltip has to say
 * which of the three kinds of change it is attached to.
 */
function describeChange(added: number, removed: number): string {
  const lines = (n: number) => `${n} line${n === 1 ? '' : 's'}`;
  if (added > 0 && removed > 0) return `${lines(removed)} replaced by ${lines(added)}`;
  if (added > 0) return `${lines(added)} added`;
  return `${lines(removed)} removed`;
}
