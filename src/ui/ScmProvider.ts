import * as vscode from 'vscode';

import type { Logger } from '../log';
import type { IgnoreRules } from '../scan/IgnoreRules';
import type { FileStatus, FileStatusCode } from '../store/CheckpointStore';
import { toAbs, toRelPosix } from '../util/paths';
import { BaselineQuickDiffProvider } from './QuickDiffProvider';

/**
 * §7.4 — the Source Control surface.
 *
 * Using the SCM API rather than a custom TreeView buys native resource styling,
 * keyboard navigation, multi-select, inline action icons, the Activity Bar
 * count badge, and quick-diff gutter indicators — all at no implementation
 * cost.
 */

const STATUS_LABEL: Record<FileStatusCode, string> = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
};

const STATUS_ICON: Record<FileStatusCode, string> = {
  M: 'diff-modified',
  A: 'diff-added',
  D: 'diff-removed',
};

const STATUS_COLOR: Record<FileStatusCode, string> = {
  M: 'gitDecoration.modifiedResourceForeground',
  A: 'gitDecoration.addedResourceForeground',
  D: 'gitDecoration.deletedResourceForeground',
};

export class ScmProvider implements vscode.Disposable {
  private readonly scm: vscode.SourceControl;
  private readonly group: vscode.SourceControlResourceGroup;
  readonly quickDiff: BaselineQuickDiffProvider;

  /** Current pending set, keyed by workspace-relative POSIX path. */
  private statuses = new Map<string, FileStatusCode>();
  /** Resource URIs shown last time, so stale quick-diff bars can be refreshed. */
  private lastUris: vscode.Uri[] = [];

  constructor(
    readonly worktree: string,
    rules: () => IgnoreRules,
    isInBaseline: (relPath: string) => boolean,
    private readonly log: Logger,
  ) {
    this.scm = vscode.scm.createSourceControl('lfct', 'AI Changes', vscode.Uri.file(worktree));
    this.quickDiff = new BaselineQuickDiffProvider(worktree, rules, isInBaseline);
    this.scm.quickDiffProvider = this.quickDiff;
    // There is no commit-message concept here; Accept is bookkeeping, not a
    // commit the user authors.
    if (this.scm.inputBox) this.scm.inputBox.visible = false;

    this.group = this.scm.createResourceGroup('pending', 'Pending Changes');
    this.group.hideWhenEmpty = true;
  }

  /** Snapshot of the current pending set. */
  get current(): FileStatus[] {
    return [...this.statuses.entries()].map(([relPath, status]) => ({ relPath, status }));
  }

  statusOf(relPath: string): FileStatusCode | undefined {
    return this.statuses.get(relPath);
  }

  get count(): number {
    return this.statuses.size;
  }

  setStatuses(statuses: readonly FileStatus[]): void {
    const next = new Map<string, FileStatusCode>();
    for (const s of statuses) next.set(s.relPath, s.status);
    this.statuses = next;

    const states = statuses.map((s) => this.toResourceState(s));
    this.group.resourceStates = states;
    // §7.4 — drives the Activity Bar count badge.
    this.scm.count = statuses.length;

    // Refresh gutter bars for everything that entered or left the list.
    const uris = states.map((s) => s.resourceUri);
    this.quickDiff.fireChange([...this.lastUris, ...uris]);
    this.lastUris = uris;

    this.log.debug(`SCM updated: ${statuses.length} pending resource(s).`);
  }

  private toResourceState(status: FileStatus): vscode.SourceControlResourceState {
    const resourceUri = vscode.Uri.file(toAbs(this.worktree, status.relPath));
    const label = STATUS_LABEL[status.status];

    return {
      resourceUri,
      command: {
        // §4.4 — the default click action is the inline unified patch (§7.5.1),
        // not the two-pane editor.
        command: 'lfct.openDiff',
        title: 'Open Changes',
        arguments: [{ relPath: status.relPath, status: status.status }],
      },
      decorations: {
        // A deleted file reads as deleted at a glance.
        strikeThrough: status.status === 'D',
        faded: false,
        tooltip: `${label} by an external process — click to review, then Accept or Reject`,
        iconPath: new vscode.ThemeIcon(
          STATUS_ICON[status.status],
          new vscode.ThemeColor(STATUS_COLOR[status.status]),
        ),
      },
      // Lets `menus` `when` clauses vary per status.
      contextValue: status.status,
    };
  }

  dispose(): void {
    this.quickDiff.dispose();
    this.group.dispose();
    this.scm.dispose();
  }
}

/**
 * SCM inline and context-menu commands receive either a resource state, an
 * array of them when several rows are selected, or the lightweight descriptor
 * the resource's own `command` passes. Normalize all three.
 */
export function resolveCommandTargets(
  worktree: string,
  scm: ScmProvider,
  args: unknown[],
): FileStatus[] {
  const out = new Map<string, FileStatusCode>();

  const consider = (relPath: string | undefined, status?: FileStatusCode) => {
    if (!relPath) return;
    const resolved = status ?? scm.statusOf(relPath);
    if (resolved) out.set(relPath, resolved);
  };

  const visit = (value: unknown): void => {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const v of value) visit(v);
      return;
    }
    // The editor title bar and the Explorer context menu pass a bare `Uri`
    // rather than a resource state, so a command reachable from there arrives
    // in a different shape than the same command invoked from the SCM view.
    if (value instanceof vscode.Uri) {
      if (value.scheme === 'file') consider(toRelPosix(worktree, value.fsPath));
      return;
    }
    const candidate = value as {
      relPath?: string;
      status?: FileStatusCode;
      resourceUri?: vscode.Uri;
      contextValue?: string;
    };
    if (typeof candidate.relPath === 'string') {
      consider(candidate.relPath, candidate.status);
      return;
    }
    if (candidate.resourceUri) {
      const rel = toRelPosix(worktree, candidate.resourceUri.fsPath);
      consider(rel, candidate.contextValue as FileStatusCode | undefined);
    }
  };

  visit(args);
  return [...out.entries()].map(([relPath, status]) => ({ relPath, status }));
}
