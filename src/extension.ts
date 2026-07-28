import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { ChangeDetector } from './detect/ChangeDetector';
import { GitOpMonitor } from './detect/GitOpMonitor';
import { reconcile, SweepScheduler } from './detect/reconcile';
import { attachVscodeGitApi } from './detect/vscodeGitApi';
import type { Logger } from './log';
import { OutputChannelLogger } from './outputLog';
import { IgnoreRules } from './scan/IgnoreRules';
import { WorkspaceWalker } from './scan/WorkspaceWalker';
import { Settings } from './settings';
import { CheckpointStore, type FileStatus } from './store/CheckpointStore';
import { detectGitVersion, MIN_GIT_VERSION, versionAtLeast } from './store/git';
import { SchemaMismatchError, WorktreeMismatchError } from './store/init';
import { BaselineContentProvider } from './ui/BaselineContentProvider';
import { HunkCodeLensProvider } from './ui/HunkCodeLensProvider';
import { InlineDiffDecorator } from './ui/InlineDiffDecorator';
import { registerCommands } from './ui/commands';
import { Notifier } from './ui/notify';
import { PatchContentProvider } from './ui/PatchContentProvider';
import { PatchDecorator } from './ui/PatchDecorator';
import { ScmProvider } from './ui/ScmProvider';
import { BASELINE_SCHEME, PATCH_SCHEME } from './ui/uris';
import { toRelPosix } from './util/paths';

/**
 * §8.1 — activation.
 *
 * `activationEvents: ["onStartupFinished"]`, never `"*"`: startup cost must not
 * be attributed to us, and P1 requires activate() to return in under 200ms with
 * the baseline built asynchronously behind a progress notification.
 */

const READY_CONTEXT_KEY = 'lfct.ready';
/** True while the focused editor holds a file the pending list is reporting. */
const ACTIVE_FILE_PENDING_KEY = 'lfct.activeFilePending';
/** Focus-regained sweeps are throttled to this (§7.3). */
const FOCUS_SWEEP_THROTTLE_MS = 30_000;
/** §9.3 — pack loose objects on a long idle interval. */
const GC_INTERVAL_MS = 30 * 60 * 1000;

let controller: Controller | undefined;

/**
 * Returned from `activate` as the extension's public API. It exists so the
 * extension-host suite (§13.3) can await baseline readiness deterministically
 * rather than sleeping, which would make those tests flaky by construction.
 */
export interface LfctApi {
  /** Resolves once the baseline exists and mutating commands are enabled. */
  whenReady(): Promise<boolean>;
  /** Runs a full reconciliation sweep and returns when the SCM list is current. */
  refresh(): Promise<void>;
  /** The current pending set. */
  pending(): FileStatus[];
  storagePath(): string;
}

export async function activate(context: vscode.ExtensionContext): Promise<LfctApi | undefined> {
  const log = new OutputChannelLogger();
  context.subscriptions.push(log);

  const settings = new Settings();
  context.subscriptions.push(settings);

  if (!settings.value.enabled) {
    log.info('lfct.enabled is false; not activating.');
    return;
  }

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    log.info('No workspace folder open; nothing to track.');
    return;
  }
  // N2 — multi-root is a non-goal for v1. Detect and disable with a clear
  // message rather than tracking one folder and silently ignoring the rest.
  if (folders.length > 1) {
    log.warn(`Multi-root workspace (${folders.length} folders); disabling.`);
    vscode.window.showInformationMessage(
      'AI Undo does not support multi-root workspaces yet, so it is disabled for this window.',
    );
    return;
  }

  const worktree = folders[0].uri.fsPath;
  if (!context.storageUri) {
    log.error('No workspace storage available; cannot create a checkpoint store.');
    return;
  }
  const storagePath = context.storageUri.fsPath;

  // E5 — a missing git binary is a hard stop with an actionable message. No
  // silent degradation: a store we cannot write is worse than no store.
  const gitVersion = await detectGitVersion();
  if (!gitVersion) {
    log.error('git binary not found on PATH.');
    const choice = await vscode.window.showErrorMessage(
      'AI Undo needs the `git` command, which was not found on your PATH.',
      'Install Git',
    );
    if (choice === 'Install Git') {
      void vscode.env.openExternal(vscode.Uri.parse('https://git-scm.com/downloads'));
    }
    return;
  }
  if (!versionAtLeast(gitVersion, MIN_GIT_VERSION)) {
    log.error(`git ${gitVersion.raw} is older than the required ${MIN_GIT_VERSION.join('.')}.`);
    vscode.window.showErrorMessage(
      `AI Undo needs git ${MIN_GIT_VERSION.join('.')} or newer (found ${gitVersion.raw}).`,
    );
    return;
  }

  try {
    controller = new Controller(context, settings, log, worktree, storagePath);
    await controller.start(gitVersion);
    context.subscriptions.push(controller);
    return controller.api;
  } catch (err) {
    await reportStartupFailure(err, log);
    return undefined;
  }
}

export async function deactivate(): Promise<void> {
  controller?.dispose();
  controller = undefined;
}

async function reportStartupFailure(err: unknown, log: Logger): Promise<void> {
  // E21 — a store from an incompatible version. Refuse rather than migrate:
  // silently misinterpreting an old store is worse than stopping.
  if (err instanceof SchemaMismatchError) {
    log.error(err.message);
    const choice = await vscode.window.showErrorMessage(
      `${err.message} Rebuild the baseline to continue.`,
      'Rebuild Baseline',
    );
    if (choice === 'Rebuild Baseline') {
      void vscode.commands.executeCommand('lfct.rebuildBaseline');
    }
    return;
  }
  // E4 — the store belongs to a different work tree. Operating on it would
  // restore one project's files into another.
  if (err instanceof WorktreeMismatchError) {
    log.error(err.message);
    vscode.window.showErrorMessage(`AI Undo: ${err.message}`);
    return;
  }
  log.error(`Activation failed: ${String(err)}`);
  vscode.window.showErrorMessage(
    `AI Undo failed to start: ${err instanceof Error ? err.message : String(err)}`,
  );
}

class Controller implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private store!: CheckpointStore;
  private rules!: IgnoreRules;
  private walker!: WorkspaceWalker;
  private detector!: ChangeDetector;
  private gitMonitor!: GitOpMonitor;
  private scm!: ScmProvider;
  private baselineProvider!: BaselineContentProvider;
  private patchProvider!: PatchContentProvider;
  private patchDecorator!: PatchDecorator;
  private notifier!: Notifier;
  private sweeps!: SweepScheduler;
  private decorator!: InlineDiffDecorator;
  private hunkLenses!: HunkCodeLensProvider;

  private ready = false;
  private knownFiles = new Set<string>();
  /**
   * Ancestor directories of `knownFiles`, derived on demand and dropped on
   * every sweep. Built lazily because a workspace where nothing is ever deleted
   * outside the tracked set never needs it at all.
   */
  private knownDirsCache: Set<string> | undefined;
  private baselinePaths = new Set<string>();
  /**
   * Guards against a slow sweep finishing after a newer one and writing stale
   * statuses over fresh ones. Commands await `runSweep` directly, so overlap is
   * routine rather than exceptional.
   */
  private sweepGeneration = 0;
  private periodicTimer: NodeJS.Timeout | undefined;
  private gcTimer: NodeJS.Timeout | undefined;

  /** Settled once the baseline bootstrap finishes, successfully or not. */
  private resolveReady!: (ok: boolean) => void;
  private readonly readyPromise = new Promise<boolean>((resolve) => {
    this.resolveReady = resolve;
  });

  readonly api: LfctApi = {
    whenReady: () => this.readyPromise,
    refresh: () => this.runSweep('api'),
    pending: () => this.scm.current,
    storagePath: () => this.storagePath,
  };

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly settings: Settings,
    private readonly log: OutputChannelLogger,
    private readonly worktree: string,
    private readonly storagePath: string,
  ) {}

  async start(gitVersion: Awaited<ReturnType<typeof detectGitVersion>>): Promise<void> {
    if (!gitVersion) throw new Error('git version unavailable');
    const extensionVersion = String(this.context.extension.packageJSON.version ?? '0.0.0');

    this.rules = new IgnoreRules(this.worktree, this.settings.value, this.storagePath);
    this.walker = new WorkspaceWalker(this.worktree, this.rules, this.log);
    this.notifier = new Notifier(() => this.settings.value, this.log);

    this.store = await CheckpointStore.open({
      storagePath: this.storagePath,
      worktree: this.worktree,
      version: gitVersion,
      extensionVersion,
      fsMonitor: this.settings.value.fsMonitor === 'on',
      log: this.log,
    });
    this.disposables.push({ dispose: () => this.store.dispose() });

    await this.warnOnConcurrentWindow();

    this.gitMonitor = new GitOpMonitor({ worktree: this.worktree, log: this.log });
    await this.gitMonitor.start();
    this.disposables.push(this.gitMonitor);
    this.disposables.push(...attachVscodeGitApi(this.gitMonitor, this.worktree, this.log));

    this.detector = new ChangeDetector({
      config: this.settings.value,
      isTracked: (abs) => this.rules.isTracked(abs),
      gitMarkers: this.gitMonitor.tracker,
      log: this.log,
    });
    this.disposables.push({ dispose: () => this.detector.dispose() });

    this.registerUi();
    this.registerWatchers();

    this.sweeps = new SweepScheduler((reason) => this.runSweep(reason), this.log);

    // P1 — activate() must return fast, so the baseline build runs detached
    // behind its own progress notification.
    void this.bootstrapBaseline();
  }

  // ------------------------------------------------------------------ wiring

  private registerUi(): void {
    this.scm = new ScmProvider(
      this.worktree,
      () => this.rules,
      (rel) => this.baselinePaths.has(rel),
      this.log,
    );
    this.disposables.push(this.scm);

    this.baselineProvider = new BaselineContentProvider(this.store, this.log);
    this.patchProvider = new PatchContentProvider(this.store, this.log);
    // Full-line green/red in the patch view; the `.diff` grammar only colors text.
    this.patchDecorator = new PatchDecorator((uri) => this.patchProvider.linesFor(uri));
    this.disposables.push(
      this.baselineProvider,
      this.patchProvider,
      this.patchDecorator,
      vscode.workspace.registerTextDocumentContentProvider(BASELINE_SCHEME, this.baselineProvider),
      vscode.workspace.registerTextDocumentContentProvider(PATCH_SCHEME, this.patchProvider),
    );

    // The live inline diff (§16, pulled forward): decorations in the real file
    // plus per-hunk controls, rather than a read-only patch tab.
    this.decorator = new InlineDiffDecorator(
      this.worktree,
      this.store,
      (rel) => this.scm.statusOf(rel) === 'M',
      this.log,
    );
    this.hunkLenses = new HunkCodeLensProvider(
      this.worktree,
      this.decorator,
      () => this.settings.value.showHunkControls,
    );
    this.disposables.push(
      this.decorator,
      this.hunkLenses,
      vscode.languages.registerCodeLensProvider({ scheme: 'file' }, this.hunkLenses),
    );

    this.disposables.push(
      ...registerCommands({
        store: this.store,
        scm: this.scm,
        detector: this.detector,
        decorator: this.decorator,
        log: this.log,
        config: () => this.settings.value,
        worktree: this.worktree,
        storagePath: this.storagePath,
        isReady: () => this.ready,
        refresh: (reason) => this.runSweep(reason),
        invalidateContent: (relPaths) => this.invalidateContent(relPaths),
        rebuildBaseline: () => this.rebuildBaseline(),
        showLog: () => this.log.show(),
      }),
    );
  }

  private registerWatchers(): void {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    this.disposables.push(watcher);

    this.disposables.push(
      watcher.onDidCreate((uri) => void this.onFsEvent(uri, 'create')),
      watcher.onDidChange((uri) => void this.onFsEvent(uri, 'change')),
      watcher.onDidDelete((uri) => void this.onFsEvent(uri, 'delete')),
    );

    // §6.3 — these fire before or around the disk write, which is the ordering
    // that makes attribution possible at all.
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (doc.uri.scheme === 'file') this.detector.noteExpectedWrite(doc.uri.fsPath);
      }),
      vscode.workspace.onDidCreateFiles((e) => {
        this.detector.noteExpectedWrites(e.files.map((f) => f.fsPath));
      }),
      vscode.workspace.onDidDeleteFiles((e) => {
        this.detector.noteExpectedWrites(e.files.map((f) => f.fsPath));
      }),
      // §6.9 — a rename through the Explorer must mark *both* paths, or the
      // create half surfaces as an agent write.
      vscode.workspace.onDidRenameFiles((e) => {
        for (const { oldUri, newUri } of e.files) {
          this.detector.noteExpectedWrite(oldUri.fsPath);
          this.detector.noteExpectedWrite(newUri.fsPath);
        }
      }),
    );

    this.disposables.push(
      this.detector.onBurstSettled((e) => void this.onBurstSettled(e)),
      this.detector.onUserEdit((paths) => void this.onUserEdit(paths)),
      this.detector.onSweepRequested((e) => this.sweeps.request(e.reason)),
    );

    // §7.3 — the watcher misses changes made while the window was closed and
    // drops events under load, so focus regained is a sweep trigger.
    this.disposables.push(
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) this.sweeps.request('focus', FOCUS_SWEEP_THROTTLE_MS);
      }),
      // Drives the editor-title button: our diff has to be reachable from a
      // file opened through the Explorer, not only from the pending list.
      vscode.window.onDidChangeActiveTextEditor(() => this.updateActiveFileContext()),
    );

    this.disposables.push(
      this.settings.onDidChange((config) => {
        this.detector.updateConfig(config);
        this.restartPeriodicSweep();
      }),
      // §11 — a rebuild discards pending changes by definition, so prompt
      // rather than doing it silently.
      this.settings.onDidChangeTrackedSet(() => void this.onTrackedSetChanged()),
    );

    this.restartPeriodicSweep();
    this.gcTimer = setInterval(() => void this.store.gc(), GC_INTERVAL_MS);
    this.disposables.push({
      dispose: () => {
        if (this.gcTimer) clearInterval(this.gcTimer);
        if (this.periodicTimer) clearInterval(this.periodicTimer);
      },
    });
  }

  private restartPeriodicSweep(): void {
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = undefined;
    }
    const interval = this.settings.value.reconcileIntervalMs;
    if (interval > 0) {
      this.periodicTimer = setInterval(() => this.sweeps.request('periodic'), interval);
    }
  }

  // ------------------------------------------------------------------ events

  /**
   * P2 — this runs on every filesystem event in the workspace; during an
   * `npm install` that is tens of thousands per second. The denylist check
   * inside the detector is synchronous and allocation-light; the only async
   * work here is the directory probe, which is skipped for `change` events
   * (by far the most common kind).
   */
  private async onFsEvent(uri: vscode.Uri, kind: 'create' | 'change' | 'delete'): Promise<void> {
    if (uri.scheme !== 'file') return;
    const absPath = uri.fsPath;

    let isDirectory = false;
    if (kind === 'create') {
      try {
        isDirectory = (await fs.lstat(absPath)).isDirectory();
      } catch {
        isDirectory = false;
      }
    } else if (kind === 'delete') {
      // It is already gone, so there is nothing to stat. If any file we know
      // about lived underneath it, it was a directory.
      //
      // This runs on every delete event in the workspace, so it must not scan
      // `knownFiles`: a path we do not track never matches, which made the miss
      // case — deleting a `dist` or `target` tree, none of whose paths are
      // tracked — pay a full scan per event. At 50k tracked files that was
      // ~0.25ms each, or five seconds of blocked main thread for a 20k-file
      // build directory.
      const rel = toRelPosix(this.worktree, absPath);
      isDirectory =
        rel !== undefined && !this.knownFiles.has(rel) && this.knownDirs().has(rel);
    }

    this.detector.handleFsEvent({ absPath, kind, isDirectory });
  }

  /** §6.8 — classification has already happened; this decides what to do about it. */
  private async onBurstSettled(e: {
    paths: string[];
    origin: 'agent' | 'git';
  }): Promise<void> {
    const relPaths = e.paths
      .map((abs) => toRelPosix(this.worktree, abs))
      .filter((rel): rel is string => rel !== undefined);
    if (relPaths.length === 0) return;

    if (e.origin === 'git') {
      await this.handleGitOriginBurst(relPaths);
      return;
    }

    await this.runSweep('burst');
    await this.notifier.burst(this.scm.count, () => {
      void vscode.commands.executeCommand('workbench.view.scm');
    });
  }

  /**
   * §6.8 — git operations have the reflog, ORIG_HEAD and the stash. Agent
   * writes have nothing. Auto-accepting keeps `git pull` out of the pending
   * list, which matters because Reject All would otherwise undo the pull.
   */
  private async handleGitOriginBurst(relPaths: string[]): Promise<void> {
    const mode = this.settings.value.gitOperations;

    if (mode === 'prompt') {
      const choice = await vscode.window.showWarningMessage(
        `A git operation changed ${relPaths.length} file(s).`,
        { modal: true, detail: 'Accept these silently, or review them as pending changes?' },
        'Accept',
        'Review',
      );
      if (choice !== 'Accept') {
        await this.runSweep('git-op-surface');
        return;
      }
    } else if (mode === 'surface') {
      await this.runSweep('git-op-surface');
      return;
    }

    try {
      await this.store.commitPaths(relPaths, `git operation (${relPaths.length} file(s))`);
      this.notifier.gitOperationAutoAccepted(relPaths.length);
    } catch (err) {
      this.log.error(`Failed to auto-accept a git operation: ${String(err)}`);
    }
    await this.runSweep('git-op');
  }

  /**
   * §6.4 — the user's own save. The baseline advances silently: no badge, no
   * toast, nothing in the list. This is the behavior that keeps the pending
   * list meaningful.
   */
  private async onUserEdit(absPaths: string[]): Promise<void> {
    if (!this.ready) return;
    const relPaths = absPaths
      .map((abs) => toRelPosix(this.worktree, abs))
      .filter((rel): rel is string => rel !== undefined);
    if (relPaths.length === 0) return;

    try {
      await this.store.commitPaths(relPaths, 'user edit');
    } catch (err) {
      this.log.error(`Failed to record a user edit: ${String(err)}`);
      return;
    }

    // Only refresh when one of these files was actually pending — an agent
    // wrote it and the user then edited and saved it. Otherwise there is
    // nothing to redraw and a full walk would be wasted.
    if (relPaths.some((rel) => this.scm.statusOf(rel) !== undefined)) {
      this.invalidateContent(relPaths);
      await this.runSweep('user-edit');
    }
  }

  // ------------------------------------------------------------------- sweeps

  private async runSweep(reason: string): Promise<void> {
    if (!this.ready) return;
    const generation = ++this.sweepGeneration;
    try {
      const result = await reconcile(this.store, this.walker, this.log);
      if (generation !== this.sweepGeneration) {
        this.log.debug(`Sweep "${reason}" superseded by a newer one; discarding its result.`);
        return;
      }
      // Reused to classify directory-delete events, which cannot be stat'd.
      this.knownFiles = new Set(result.onDisk);
      this.knownDirsCache = undefined;
      this.baselinePaths = result.tracked;
      this.scm.setStatuses(result.statuses);
      this.updateActiveFileContext();
      // Redraw the live inline diff against the new pending set.
      this.decorator.invalidate();

      const stats = this.walker.lastWalkStats;
      if (stats.oversized.length > 0) void this.notifier.oversizedFiles(stats.oversized);
      if (stats.ambiguousWithSource.length > 0) {
        void this.notifier.ambiguousDirectories(stats.ambiguousWithSource);
      }
      if (stats.nestedRepos.length > 0) {
        this.log.debug(`Skipped ${stats.nestedRepos.length} nested repository(ies).`);
      }
      this.log.debug(`Sweep "${reason}" finished in ${result.durationMs}ms.`);
    } catch (err) {
      this.log.error(`Sweep "${reason}" failed: ${String(err)}`);
    }
  }

  /**
   * Every directory that holds a tracked file, at any depth. One pass over
   * `knownFiles` builds it; a lookup is then O(1) instead of a scan.
   */
  private knownDirs(): Set<string> {
    if (this.knownDirsCache) return this.knownDirsCache;
    const dirs = new Set<string>();
    for (const rel of this.knownFiles) {
      let slash = rel.indexOf('/');
      while (slash !== -1) {
        dirs.add(rel.slice(0, slash));
        slash = rel.indexOf('/', slash + 1);
      }
    }
    this.knownDirsCache = dirs;
    return dirs;
  }

  /**
   * A file can start or stop being pending while it sits open, so this is
   * refreshed both on focus change and after every sweep.
   */
  private updateActiveFileContext(): void {
    const editor = vscode.window.activeTextEditor;
    const rel =
      editor && editor.document.uri.scheme === 'file'
        ? toRelPosix(this.worktree, editor.document.uri.fsPath)
        : undefined;
    const pending = rel !== undefined && this.scm.statusOf(rel) !== undefined;
    void vscode.commands.executeCommand('setContext', ACTIVE_FILE_PENDING_KEY, pending);
  }

  private invalidateContent(relPaths: readonly string[]): void {
    // §7.5.1 — fire on *both* providers, or open diffs and patch views go stale.
    this.baselineProvider.fireChange(relPaths);
    this.patchProvider.fireChange(relPaths);
    this.decorator.invalidate(relPaths);
    this.scm.quickDiff.fireChange(
      relPaths.map((rel) => vscode.Uri.file(path.resolve(this.worktree, rel))),
    );
  }

  // ---------------------------------------------------------------- baseline

  /**
   * §8.2 — the baseline must be eager. The watcher fires *after* a write has
   * landed, at which point the previous content is already gone from disk, so
   * lazy snapshotting could never protect the first change to any file — which
   * is precisely the change this extension exists to protect.
   */
  private async bootstrapBaseline(): Promise<void> {
    try {
      if (this.store.hasBaseline()) {
        this.setReady(true);
        // S15/E9 — changes made while the window was closed produced no watcher
        // events at all. The sweep is what catches them.
        await this.runSweep('activation');
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'AI Undo: creating initial baseline…',
          cancellable: true,
        },
        async (progress, token) => {
          const paths = await this.walker.walk(token);
          if (token.isCancellationRequested) return;
          progress.report({ message: `${paths.length} files` });
          await this.store.createInitialBaseline(paths, progress, token);
        },
      );

      if (!this.store.hasBaseline()) {
        this.log.warn('Baseline creation was cancelled; tracking stays disabled until reload.');
        vscode.window.showWarningMessage(
          'AI Undo: baseline creation was cancelled. Run "Rebuild Baseline From Disk" to try again.',
        );
        return;
      }

      this.setReady(true);
      await this.runSweep('post-baseline');
      const stats = this.walker.lastWalkStats;
      this.log.activity(
        `Initial baseline: ${stats.files} files tracked, ${stats.prunedDirectories} directories pruned, ${stats.durationMs}ms.`,
      );
    } catch (err) {
      this.log.error(`Baseline bootstrap failed: ${String(err)}`);
      vscode.window.showErrorMessage(
        `AI Undo could not create a baseline: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.detector.start();
      this.resolveReady(this.ready);
    }
  }

  /** §17.4 — destructive by definition, so it is prompt-first. */
  private async rebuildBaseline(): Promise<void> {
    const pending = this.scm.count;
    const choice = await vscode.window.showWarningMessage(
      'Rebuild the baseline from what is currently on disk?',
      {
        modal: true,
        detail:
          (pending > 0
            ? `${pending} pending change(s) will be accepted as the new baseline and can no longer be rejected. `
            : '') + 'Existing history is kept but is no longer reachable from the pending list.',
      },
      'Rebuild',
    );
    if (choice !== 'Rebuild') return;

    this.setReady(false);
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'AI Undo: rebuilding baseline…',
          cancellable: true,
        },
        async (progress, token) => {
          this.rules = new IgnoreRules(this.worktree, this.settings.value, this.storagePath);
          this.walker = new WorkspaceWalker(this.worktree, this.rules, this.log);
          const paths = await this.walker.walk(token);
          if (token.isCancellationRequested) return;
          await this.store.rebuild(paths, progress, token);
        },
      );
      if (this.store.hasBaseline()) {
        this.setReady(true);
        await this.runSweep('rebuild');
        this.log.activity('Baseline rebuilt from disk.');
        vscode.window.showInformationMessage('Baseline rebuilt from the current contents of disk.');
      }
    } catch (err) {
      this.log.error(`Rebuild failed: ${String(err)}`);
      vscode.window.showErrorMessage(
        `Could not rebuild the baseline: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async onTrackedSetChanged(): Promise<void> {
    this.rules = new IgnoreRules(this.worktree, this.settings.value, this.storagePath);
    this.walker = new WorkspaceWalker(this.worktree, this.rules, this.log);
    const choice = await vscode.window.showInformationMessage(
      'The set of tracked files changed. Rebuild the baseline so it matches?',
      'Rebuild',
      'Later',
    );
    if (choice === 'Rebuild') await this.rebuildBaseline();
    else await this.runSweep('config-change');
  }

  private setReady(ready: boolean): void {
    this.ready = ready;
    // §8.1 — Reject must stay disabled until this is true. Rejecting against a
    // half-built baseline restores a file to content that was never real.
    void vscode.commands.executeCommand('setContext', READY_CONTEXT_KEY, ready);
  }

  /**
   * E19 — the same workspace open in two windows (Stable plus Insiders, or two
   * profiles) gets two separate stores whose baselines diverge silently. Low
   * frequency, and blocking would be worse than the divergence, so: detect and
   * log.
   */
  private async warnOnConcurrentWindow(): Promise<void> {
    const lockPath = path.join(this.storagePath, 'window.lock');
    try {
      const raw = await fs.readFile(lockPath, 'utf8');
      const previous = JSON.parse(raw) as { pid: number; at: string };
      if (previous.pid !== process.pid && isProcessAlive(previous.pid)) {
        this.log.warn(
          `Another window (pid ${previous.pid}, since ${previous.at}) appears to have this workspace open. ` +
            'Baselines are per profile and will diverge between the two.',
        );
      }
    } catch {
      /* no previous lock, or unreadable */
    }
    try {
      await fs.writeFile(
        lockPath,
        JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
        'utf8',
      );
    } catch (err) {
      this.log.debug(`Could not write window lock: ${String(err)}`);
    }
  }

  dispose(): void {
    for (const d of this.disposables.reverse()) {
      try {
        d.dispose();
      } catch {
        /* disposal must never throw during shutdown */
      }
    }
    this.disposables.length = 0;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
