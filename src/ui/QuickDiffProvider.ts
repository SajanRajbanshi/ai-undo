import * as vscode from 'vscode';

import type { IgnoreRules } from '../scan/IgnoreRules';
import { toRelPosix } from '../util/paths';
import { baselineUri } from './uris';

/**
 * §4.1 / §7.5.1 surface 2 — quick-diff gutter bars.
 *
 * Setting `SourceControl.quickDiffProvider` puts colored change bars in the
 * gutter of every open file showing exactly which lines the agent touched,
 * live, without opening a diff editor. Clicking a bar opens VS Code's native
 * inline peek with the baseline lines in place — a genuine inline diff
 * experience *inside the editable file*, which is the answer to "what did the
 * agent change in the file I'm working in right now".
 *
 * All of that comes free with the SCM API, which is most of why §4.1 chooses it
 * over a custom TreeView.
 */
export class BaselineQuickDiffProvider implements vscode.QuickDiffProvider {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChangeOriginalResource = this.changeEmitter.event;

  constructor(
    private readonly worktree: string,
    private readonly rules: () => IgnoreRules,
    /** Paths present in the baseline, refreshed on every sweep. */
    private readonly isInBaseline: (relPath: string) => boolean,
  ) {}

  provideOriginalResource(uri: vscode.Uri): vscode.ProviderResult<vscode.Uri> {
    if (uri.scheme !== 'file') return undefined;
    const rel = toRelPosix(this.worktree, uri.fsPath);
    if (rel === undefined) return undefined;
    if (!this.rules().isTrackedRel(rel)) return undefined;
    // A file with no baseline would resolve to empty content, which VS Code
    // renders as "every line is new". That is right for a file the agent just
    // created, but actively misleading for one excluded by the size cap or by a
    // config change — it would claim the whole file had changed. Only offer an
    // original for paths the baseline actually holds; git behaves the same way
    // for untracked files.
    if (!this.isInBaseline(rel)) return undefined;
    return baselineUri(rel);
  }

  /** Called after Accept/Reject and after each refresh so bars do not go stale. */
  fireChange(uris: readonly vscode.Uri[]): void {
    for (const uri of uris) this.changeEmitter.fire(uri);
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}
