/**
 * A minimal stand-in for `vscode.EventEmitter`, shape-compatible with
 * `vscode.Event<T>`. Modules that must stay testable without an extension host
 * (ChangeDetector, GitOpMonitor's marker tracker) use this; UI modules that
 * already depend on `vscode` use the real one.
 */

export interface Disposable {
  dispose(): void;
}

export type Listener<T> = (e: T) => unknown;

export type Event<T> = (listener: Listener<T>, thisArgs?: unknown) => Disposable;

export class Emitter<T> {
  private listeners: Listener<T>[] = [];

  readonly event: Event<T> = (listener, thisArgs) => {
    const bound = thisArgs ? listener.bind(thisArgs) : listener;
    this.listeners.push(bound);
    return {
      dispose: () => {
        const i = this.listeners.indexOf(bound);
        if (i !== -1) this.listeners.splice(i, 1);
      },
    };
  };

  fire(value: T): void {
    // Copy first: a listener may dispose itself or add another.
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }

  get listenerCount(): number {
    return this.listeners.length;
  }

  dispose(): void {
    this.listeners = [];
  }
}
