import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';

import type { Logger } from '../log';
import type { CheckpointStore } from '../store/CheckpointStore';
import { binaryPlaceholder, isBinary } from '../store/patch';
import { toAbs } from '../util/paths';
import { baselineUri, relPathFromBaselineUri } from './uris';

/**
 * §7.5 — serves the left-hand side of the side-by-side diff and the "original"
 * that the quick-diff gutter compares against.
 */
export class BaselineContentProvider
  implements vscode.TextDocumentContentProvider, vscode.Disposable
{
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changeEmitter.event;

  constructor(
    private readonly store: CheckpointStore,
    private readonly log: Logger,
  ) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const relPath = relPathFromBaselineUri(uri);
    // The right-hand side of a `D` diff: the file is gone from disk, so the
    // comparison is "baseline versus nothing".
    if (uri.query.includes('ref=EMPTY')) return '';
    try {
      const content = await this.store.readBaseline(relPath);
      // Absent from HEAD means the file is new, and an added file diffed
      // against empty is exactly the right reading (§7.5).
      if (content === null) return '';

      if (isBinary(content)) {
        return binaryPlaceholder(relPath, content.length, await sizeOnDisk(this.store, relPath));
      }
      return Buffer.from(content).toString('utf8');
    } catch (err) {
      this.log.error(`Failed to read baseline for ${relPath}: ${String(err)}`);
      return `# Failed to read baseline content for ${relPath}\n# ${String(err)}\n`;
    }
  }

  /**
   * §7.5 — must fire after every Accept and Reject, or open diff editors keep
   * showing stale baseline content.
   */
  fireChange(relPaths: readonly string[]): void {
    for (const relPath of relPaths) {
      this.changeEmitter.fire(baselineUri(relPath));
    }
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}

async function sizeOnDisk(store: CheckpointStore, relPath: string): Promise<number | null> {
  try {
    const st = await fs.lstat(toAbs(store.worktree, relPath));
    return st.size;
  } catch {
    return null;
  }
}
