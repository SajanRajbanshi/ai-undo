import * as vscode from 'vscode';

import type { Logger } from './log';

/**
 * §7.6 — one OutputChannel named "AI Undo".
 *
 * When this extension goes wrong it goes wrong *silently*: a file that should
 * have been tracked and wasn't. The log is therefore the primary diagnostic and
 * the artifact users attach to issue reports, so every git invocation, every
 * classification decision, and every auto-accepted git operation lands here.
 */
export class OutputChannelLogger implements Logger, vscode.Disposable {
  private readonly channel: vscode.LogOutputChannel;

  constructor(name = 'AI Undo') {
    // A LogOutputChannel gives level filtering from the UI for free, so debug
    // logging costs nothing until someone turns it on.
    this.channel = vscode.window.createOutputChannel(name, { log: true });
  }

  debug(message: string, ...args: unknown[]): void {
    this.channel.debug(message, ...args);
  }

  info(message: string, ...args: unknown[]): void {
    this.channel.info(message, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.channel.warn(message, ...args);
  }

  error(message: string, ...args: unknown[]): void {
    this.channel.error(message, ...args);
  }

  /**
   * §6.8 — the user-visible activity log. Auto-accepting a git operation is
   * invisible by design, so it must never be *undiscoverable*: every one is
   * recorded here with its file count.
   */
  activity(message: string): void {
    this.channel.appendLine(`[activity] ${message}`);
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
