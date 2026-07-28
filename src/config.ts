/**
 * Typed settings. This module is deliberately free of any `vscode` import so
 * that IgnoreRules, WorkspaceWalker, ChangeDetector and CheckpointStore can be
 * unit tested without an extension host (§13.1). The VS Code-backed reader
 * lives in `src/settings.ts`.
 */

export type NotificationMode = 'toast' | 'badge' | 'none';
export type DiffViewMode = 'liveFile' | 'patch' | 'sideBySide';
export type GitOperationMode = 'auto-accept' | 'surface' | 'prompt';
export type ConfirmRejectMode = 'always' | 'destructive' | 'never';
export type FsMonitorMode = 'off' | 'on';

export interface LfctConfig {
  enabled: boolean;
  exclude: string[];
  include: string[];
  maxFileSizeMB: number;
  notification: NotificationMode;
  diffView: DiffViewMode;
  gitOperations: GitOperationMode;
  userEditGraceMs: number;
  burstQuietMs: number;
  gitOpWindowMs: number;
  reconcileIntervalMs: number;
  confirmReject: ConfirmRejectMode;
  fsMonitor: FsMonitorMode;
  showHunkControls: boolean;
}

export const DEFAULT_CONFIG: LfctConfig = {
  enabled: true,
  exclude: [],
  include: [],
  maxFileSizeMB: 5,
  notification: 'toast',
  // A complete diff is the default: every removed and every added line, in
  // full. `liveFile` is the richer surface — it is editable and carries the
  // per-hunk controls — but it can only ever *summarize* a deletion, because
  // removed lines do not exist in the buffer and no extension API can make the
  // editor reserve space for them. Showing less than the whole change by
  // default is the wrong trade for a tool whose job is to make sure nothing an
  // agent did goes unnoticed.
  diffView: 'patch',
  gitOperations: 'auto-accept',
  userEditGraceMs: 2000,
  burstQuietMs: 750,
  gitOpWindowMs: 3000,
  reconcileIntervalMs: 60000,
  confirmReject: 'destructive',
  fsMonitor: 'off',
  showHunkControls: true,
};

/**
 * Settings whose change invalidates the tracked set and therefore requires a
 * baseline rebuild rather than a live reload (§11).
 */
export const TRACKED_SET_KEYS: readonly (keyof LfctConfig)[] = [
  'exclude',
  'include',
  'maxFileSizeMB',
];

export function resolveConfig(partial: Partial<LfctConfig> | undefined): LfctConfig {
  const c = { ...DEFAULT_CONFIG, ...(partial ?? {}) };
  return {
    ...c,
    exclude: [...c.exclude],
    include: [...c.include],
    // Guard against a user setting these to nonsense; a zero-length quiet
    // window would make bursts meaningless and a negative grace would break
    // attribution outright.
    maxFileSizeMB: clampNumber(c.maxFileSizeMB, 0.001, 4096, DEFAULT_CONFIG.maxFileSizeMB),
    userEditGraceMs: clampNumber(c.userEditGraceMs, 0, 60_000, DEFAULT_CONFIG.userEditGraceMs),
    burstQuietMs: clampNumber(c.burstQuietMs, 50, 60_000, DEFAULT_CONFIG.burstQuietMs),
    gitOpWindowMs: clampNumber(c.gitOpWindowMs, 0, 60_000, DEFAULT_CONFIG.gitOpWindowMs),
    reconcileIntervalMs: clampNumber(
      c.reconcileIntervalMs,
      0,
      24 * 60 * 60 * 1000,
      DEFAULT_CONFIG.reconcileIntervalMs,
    ),
  };
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function trackedSetChanged(a: LfctConfig, b: LfctConfig): boolean {
  return TRACKED_SET_KEYS.some((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]));
}
