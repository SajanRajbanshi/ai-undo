import * as vscode from 'vscode';

import type { LfctConfig } from '../config';
import type { Logger } from '../log';
import { formatBytes } from '../store/patch';

/**
 * §4.3 — burst notifications.
 *
 * The one rule that matters: notifications are **per burst, never per file**.
 * An agent writing 40 files must produce one toast, not forty.
 */
export class Notifier {
  /** E8 — oversized files are only ever announced once per session. */
  private readonly announcedOversized = new Set<string>();
  /** §17.1 — the ambiguous-directory notice is also once per session. */
  private announcedAmbiguous = false;

  constructor(
    private readonly config: () => LfctConfig,
    private readonly log: Logger,
  ) {}

  async burst(fileCount: number, reveal: () => void): Promise<void> {
    if (fileCount <= 0) return;
    const mode = this.config().notification;
    if (mode !== 'toast') return;

    const message =
      fileCount === 1
        ? '1 file changed by an external process'
        : `${fileCount} files changed by an external process`;

    const choice = await vscode.window.showInformationMessage(message, 'Review');
    if (choice === 'Review') reveal();
  }

  /** §6.8 — auto-accepting a git operation is silent by design, but never undiscoverable. */
  gitOperationAutoAccepted(fileCount: number): void {
    this.log.activity(
      `Auto-accepted ${fileCount} file(s) changed by a git operation (pull/rebase/stash/checkout). ` +
        'Git\'s own reflog remains the safety net for these.',
    );
  }

  /**
   * E8 — a file above the size cap is not tracked, which is a real gap in
   * coverage. It must not be silent.
   */
  async oversizedFiles(files: readonly { relPath: string; size: number }[]): Promise<void> {
    const fresh = files.filter((f) => !this.announcedOversized.has(f.relPath));
    if (fresh.length === 0) return;
    for (const f of fresh) this.announcedOversized.add(f.relPath);

    const first = fresh[0];
    const message =
      fresh.length === 1
        ? `${first.relPath} (${formatBytes(first.size)}) is above the size cap and is not being tracked.`
        : `${fresh.length} files including ${first.relPath} (${formatBytes(first.size)}) are above the size cap and are not being tracked.`;

    this.log.activity(message);
    if (this.config().notification === 'none') return;

    const choice = await vscode.window.showInformationMessage(
      message,
      'Change Size Limit',
      'Dismiss',
    );
    if (choice === 'Change Size Limit') {
      await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        'lfct.maxFileSizeMB',
      );
    }
  }

  /**
   * §17.1 — `bin`, `env`, `out` and `target` are excluded by default because
   * that is right for the overwhelming majority of projects. When one of them
   * actually holds source, say so once rather than silently untracking code.
   */
  async ambiguousDirectories(dirs: readonly string[]): Promise<void> {
    if (this.announcedAmbiguous || dirs.length === 0) return;
    this.announcedAmbiguous = true;

    const list = dirs.slice(0, 3).join(', ');
    const message =
      `Not tracking ${list}${dirs.length > 3 ? ` and ${dirs.length - 3} more` : ''}: ` +
      'these directory names usually hold build output, but this one appears to contain source files.';

    this.log.activity(message);
    if (this.config().notification === 'none') return;

    const choice = await vscode.window.showWarningMessage(message, 'Track Them', 'Keep Excluded');
    if (choice === 'Track Them') {
      const settings = vscode.workspace.getConfiguration('lfct');
      const include = settings.get<string[]>('include') ?? [];
      const merged = [...new Set([...include, ...dirs])];
      await settings.update('include', merged, vscode.ConfigurationTarget.Workspace);
    }
  }

  async storeUnavailable(reason: string, actionLabel?: string, action?: () => void): Promise<void> {
    this.log.error(reason);
    const choice = await vscode.window.showErrorMessage(
      `AI Undo: ${reason}`,
      ...(actionLabel ? [actionLabel] : []),
    );
    if (choice && choice === actionLabel) action?.();
  }
}
