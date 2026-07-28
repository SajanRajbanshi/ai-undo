import * as vscode from 'vscode';

import type { Logger } from '../log';
import { isInside } from '../util/paths';
import type { GitOpMonitor } from './GitOpMonitor';

/**
 * §6.8 — the built-in Git extension as a second marker source.
 *
 * It already watches `.git`, so it observes operations run from a terminal too.
 * The subtlety that makes this safe: `Repository.state.onDidChange` also fires
 * on ordinary work-tree changes, so recording a marker on every state change
 * would classify **every agent burst** as a git operation and auto-accept the
 * lot. Only an actual ref move counts.
 *
 * `fs.watch` in GitOpMonitor stays active alongside this, because a
 * `git stash push` never moves HEAD and is invisible here.
 */

interface GitHeadLike {
  name?: string;
  commit?: string;
}

interface RepositoryLike {
  rootUri: vscode.Uri;
  state: {
    HEAD?: GitHeadLike;
    rebaseCommit?: { hash?: string };
    onDidChange: (listener: () => void) => vscode.Disposable;
  };
}

interface GitApiLike {
  repositories: RepositoryLike[];
  onDidOpenRepository: (listener: (repo: RepositoryLike) => void) => vscode.Disposable;
}

export function attachVscodeGitApi(
  monitor: GitOpMonitor,
  worktree: string,
  log: Logger,
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitApiLike }>('vscode.git');
  if (!extension) {
    log.info('Built-in Git extension not present; relying on direct .git watching.');
    return disposables;
  }

  const wire = (api: GitApiLike) => {
    const attach = (repo: RepositoryLike) => {
      // Only the repository that owns this workspace matters.
      if (!isInside(repo.rootUri.fsPath, worktree) && !isInside(worktree, repo.rootUri.fsPath)) {
        return;
      }
      let lastCommit = repo.state.HEAD?.commit;
      let lastBranch = repo.state.HEAD?.name;
      let lastRebase = repo.state.rebaseCommit?.hash;

      disposables.push(
        repo.state.onDidChange(() => {
          const commit = repo.state.HEAD?.commit;
          const branch = repo.state.HEAD?.name;
          const rebase = repo.state.rebaseCommit?.hash;

          const moved =
            commit !== lastCommit || branch !== lastBranch || rebase !== lastRebase;
          lastCommit = commit;
          lastBranch = branch;
          lastRebase = rebase;

          // Any other state change is a work-tree change, which is exactly what
          // we must NOT treat as a git operation.
          if (moved) monitor.recordFromGitApi('HEAD/rebase moved');
        }),
      );
      log.info(`Watching git state via the built-in Git extension for ${repo.rootUri.fsPath}`);
    };

    for (const repo of api.repositories) attach(repo);
    disposables.push(api.onDidOpenRepository(attach));
  };

  const activate = async () => {
    try {
      if (!extension.isActive) await extension.activate();
      const api = extension.exports?.getAPI(1);
      if (api) wire(api);
    } catch (err) {
      log.warn(`Could not attach to the built-in Git extension: ${String(err)}`);
    }
  };
  void activate();

  return disposables;
}
