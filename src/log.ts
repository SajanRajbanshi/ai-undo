/**
 * Logging contract (§7.6). When this extension goes wrong it goes wrong
 * *silently* — a file that should have been tracked and wasn't — so the log is
 * the primary diagnostic artifact. Kept free of `vscode` imports; the
 * OutputChannel-backed implementation is in `src/outputLog.ts`.
 */

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  /** User-visible activity log: auto-accepted git operations, rebuilds, etc. (§6.8) */
  activity(message: string): void;
}

export const nullLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  activity: () => {},
};

/** Used by integration tests and by the perf harness. */
export function createMemoryLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const push = (level: string) => (message: string, ...args: unknown[]) => {
    lines.push(`[${level}] ${message}${args.length ? ' ' + args.map(fmt).join(' ') : ''}`);
  };
  return {
    lines,
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    activity: push('activity'),
  };
}

function fmt(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
