import * as vscode from 'vscode';

import {
  DEFAULT_CONFIG,
  resolveConfig,
  trackedSetChanged,
  type LfctConfig,
} from './config';

/**
 * The VS Code-backed settings reader. Kept apart from `config.ts` so every
 * module that only needs the *shape* of the configuration stays testable
 * without an extension host.
 */
export class Settings implements vscode.Disposable {
  private current: LfctConfig;
  private readonly disposables: vscode.Disposable[] = [];

  private readonly changeEmitter = new vscode.EventEmitter<LfctConfig>();
  /** Fires on any change. */
  readonly onDidChange = this.changeEmitter.event;

  private readonly trackedSetEmitter = new vscode.EventEmitter<LfctConfig>();
  /**
   * Fires only when a setting that invalidates the tracked set changes (§11).
   * The extension prompts for a rebuild rather than doing one silently, because
   * a rebuild discards pending changes by definition.
   */
  readonly onDidChangeTrackedSet = this.trackedSetEmitter.event;

  constructor() {
    this.current = readConfig();
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('lfct')) return;
        const previous = this.current;
        this.current = readConfig();
        this.changeEmitter.fire(this.current);
        if (trackedSetChanged(previous, this.current)) {
          this.trackedSetEmitter.fire(this.current);
        }
      }),
    );
  }

  get value(): LfctConfig {
    return this.current;
  }

  async update<K extends keyof LfctConfig>(key: K, value: LfctConfig[K]): Promise<void> {
    await vscode.workspace
      .getConfiguration('lfct')
      .update(key, value, vscode.ConfigurationTarget.Global);
  }

  dispose(): void {
    this.changeEmitter.dispose();
    this.trackedSetEmitter.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

function readConfig(): LfctConfig {
  const c = vscode.workspace.getConfiguration('lfct');
  const partial: Partial<LfctConfig> = {};
  for (const key of Object.keys(DEFAULT_CONFIG) as (keyof LfctConfig)[]) {
    const value = c.get(key);
    if (value !== undefined) {
      (partial as Record<string, unknown>)[key] = value;
    }
  }
  return resolveConfig(partial);
}
