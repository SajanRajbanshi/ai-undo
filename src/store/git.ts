import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { Logger } from '../log';

/**
 * The only module in the extension permitted to spawn a process (§7.6). Two
 * invariants it exists to enforce:
 *
 *  1. Serialization. Concurrent `git add`/`git commit` against one index either
 *     corrupts it or dies on `index.lock`. Every invocation goes through one
 *     promise queue (§7.1). This is a correctness requirement, not a tuning
 *     knob.
 *  2. `execFile` with an argument array — never `exec`, never an interpolated
 *     string (§S4). Paths here are chosen by an agent, so they are
 *     attacker-influenced in every sense that matters.
 */

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly code: number,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export interface GitResult {
  stdout: Buffer;
  stderr: string;
  code: number;
}

export interface GitRunOptions {
  /** Written to the child's stdin and then closed. */
  stdin?: Buffer | string;
  /** Exit codes to treat as success. 0 is always allowed. */
  allowExit?: number[];
  /** Bytes. Defaults to 64 MiB, comfortably above the default size cap. */
  maxBuffer?: number;
  timeoutMs?: number;
}

/** Commit identity. Set via the environment so no ambient value can win. */
const IDENTITY_NAME = 'AI Undo';
const IDENTITY_EMAIL = 'lfct@localhost';

/** Minimum git we can run against: `--pathspec-from-file` landed in 2.26. */
export const MIN_GIT_VERSION: readonly [number, number] = [2, 26];
/** `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` landed in 2.32. */
const CONFIG_ENV_VERSION: readonly [number, number] = [2, 32];
/** The built-in fsmonitor daemon landed in 2.37. */
export const FSMONITOR_VERSION: readonly [number, number] = [2, 37];

export interface GitVersion {
  major: number;
  minor: number;
  patch: number;
  raw: string;
}

export function parseGitVersion(raw: string): GitVersion | undefined {
  const m = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(raw);
  if (!m) return undefined;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: m[3] ? Number(m[3]) : 0,
    raw: raw.trim(),
  };
}

export function versionAtLeast(v: GitVersion, min: readonly [number, number]): boolean {
  return v.major > min[0] || (v.major === min[0] && v.minor >= min[1]);
}

/** Probes `git --version` outside the queue. Used by the activation check (E5). */
export async function detectGitVersion(gitPath = 'git'): Promise<GitVersion | undefined> {
  return new Promise((resolve) => {
    execFile(gitPath, ['--version'], { timeout: 10_000 }, (err, stdout) => {
      if (err) return resolve(undefined);
      resolve(parseGitVersion(String(stdout)));
    });
  });
}

export class Git {
  /** Serializes every invocation. See invariant 1 above. */
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;

  private constructor(
    readonly gitDir: string,
    readonly workTree: string,
    readonly version: GitVersion,
    private readonly emptyConfigPath: string,
    private readonly log: Logger,
    private readonly gitPath: string,
  ) {}

  /**
   * `emptyConfigDir` receives an empty file used to neutralize the user's
   * global and system git configuration. Doing it with a real empty file rather
   * than `/dev/null` keeps this working on Windows.
   */
  static async create(opts: {
    gitDir: string;
    workTree: string;
    version: GitVersion;
    storagePath: string;
    log: Logger;
    gitPath?: string;
  }): Promise<Git> {
    const emptyConfigPath = path.join(opts.storagePath, 'empty.gitconfig');
    await fs.mkdir(opts.storagePath, { recursive: true });
    await fs.writeFile(emptyConfigPath, '', { flag: 'w' });
    return new Git(
      opts.gitDir,
      opts.workTree,
      opts.version,
      emptyConfigPath,
      opts.log,
      opts.gitPath ?? 'git',
    );
  }

  private env(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // §5.4 — never rely on cwd to locate the repository.
      GIT_DIR: this.gitDir,
      GIT_WORK_TREE: this.workTree,
      // Nothing here ever touches the network or a terminal. Make that true by
      // construction rather than by hope.
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_PAGER: 'cat',
      // Stable, parseable, locale-independent messages.
      LC_ALL: 'C',

      // Identity. Environment beats config, so an ambient GIT_AUTHOR_NAME —
      // including an *empty* one, which git rejects outright with "empty ident
      // name not allowed" — would fail every checkpoint commit no matter what
      // §5.4 wrote into the repo config. Set it here where nothing can override
      // it.
      GIT_AUTHOR_NAME: IDENTITY_NAME,
      GIT_AUTHOR_EMAIL: IDENTITY_EMAIL,
      GIT_COMMITTER_NAME: IDENTITY_NAME,
      GIT_COMMITTER_EMAIL: IDENTITY_EMAIL,
      GIT_AUTHOR_DATE: undefined,
      GIT_COMMITTER_DATE: undefined,

      // Pathspec interpretation. `GIT_LITERAL_PATHSPECS=1` disables pathspec
      // magic entirely, which would make git read our `:(literal,top)` prefix
      // as part of the filename and match nothing — every add and every restore
      // would silently stop working. The others distort matching in subtler
      // ways. All four must be cleared.
      GIT_LITERAL_PATHSPECS: undefined,
      GIT_GLOB_PATHSPECS: undefined,
      GIT_NOGLOB_PATHSPECS: undefined,
      GIT_ICASE_PATHSPECS: undefined,

      // Repository location. Anything ambient here would send our staging,
      // objects or refs somewhere that is not our store.
      GIT_INDEX_FILE: undefined,
      GIT_OBJECT_DIRECTORY: undefined,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
      GIT_COMMON_DIR: undefined,
      GIT_NAMESPACE: undefined,
      GIT_CEILING_DIRECTORIES: undefined,
      GIT_ATTR_NOSYSTEM: '1',
    };
    // The repo-local config in §5.4 covers the dangerous settings explicitly,
    // but neutralizing global/system config removes the whole class: aliases,
    // core.excludesFile, core.autocrlf, core.hooksPath, commit.gpgsign,
    // diff.renames, and anything else the user has set.
    if (versionAtLeast(this.version, CONFIG_ENV_VERSION)) {
      env.GIT_CONFIG_GLOBAL = this.emptyConfigPath;
      env.GIT_CONFIG_SYSTEM = this.emptyConfigPath;
    } else {
      env.GIT_CONFIG_NOSYSTEM = '1';
    }
    return env;
  }

  /** Queued. Every caller in the extension goes through here. */
  run(args: string[], opts: GitRunOptions = {}): Promise<GitResult> {
    const task = this.queue.then(
      () => this.runUnqueued(args, opts),
      () => this.runUnqueued(args, opts),
    );
    // Keep the chain alive even when a call rejects.
    this.queue = task.catch(() => undefined);
    return task;
  }

  private runUnqueued(args: string[], opts: GitRunOptions): Promise<GitResult> {
    if (this.disposed) {
      return Promise.reject(new GitError('git wrapper disposed', args, -1, ''));
    }
    const started = Date.now();
    return new Promise<GitResult>((resolve, reject) => {
      const child = execFile(
        this.gitPath,
        args,
        {
          env: this.env(),
          cwd: this.workTree,
          encoding: 'buffer',
          maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
          timeout: opts.timeoutMs ?? 120_000,
          windowsHide: true,
        },
        (err, stdout, stderr) => {
          const duration = Date.now() - started;
          const out = toBuffer(stdout);
          const errText = toBuffer(stderr).toString('utf8');
          const code = err ? numericExitCode(err) : 0;
          const allowed = code === 0 || (opts.allowExit ?? []).includes(code);

          this.log.debug(
            `git ${args.join(' ')} -> ${code} in ${duration}ms` +
              (errText.trim() ? ` :: ${errText.trim().slice(0, 400)}` : ''),
          );

          if (!allowed) {
            reject(
              new GitError(
                `git ${args.join(' ')} failed with code ${code}: ${errText.trim() || String(err)}`,
                args,
                code,
                errText,
              ),
            );
            return;
          }
          resolve({ stdout: out, stderr: errText, code });
        },
      );

      child.on('error', (err) => {
        reject(new GitError(`failed to spawn git: ${err.message}`, args, -1, ''));
      });

      if (opts.stdin !== undefined) {
        child.stdin?.on('error', () => {
          // A git that exits before consuming stdin (bad pathspec, for example)
          // gives us EPIPE. The exit-code path above reports the real error.
        });
        child.stdin?.end(opts.stdin);
      } else {
        child.stdin?.end();
      }
    });
  }

  /** Convenience for the many calls whose output is UTF-8 text. */
  async text(args: string[], opts: GitRunOptions = {}): Promise<string> {
    const r = await this.run(args, opts);
    return r.stdout.toString('utf8');
  }

  /** Splits NUL-separated output, dropping the trailing empty element. */
  async nulList(args: string[], opts: GitRunOptions = {}): Promise<string[]> {
    const raw = await this.text(args, opts);
    return raw.split('\0').filter((s) => s.length > 0);
  }

  dispose(): void {
    this.disposed = true;
  }
}

/**
 * Pathspec magic prefix. Without `:(literal)` a file legitimately named
 * `*.ts`, `:foo`, or `!x` would be reinterpreted as a pattern; `top` anchors it
 * to the work-tree root so the caller's relative paths mean what they say.
 * Applied to every pathspec we hand git, including the NUL-separated ones —
 * `--pathspec-file-nul` suppresses quoting, not magic.
 */
export function literalPathspec(relPosix: string): string {
  return `:(literal,top)${relPosix}`;
}

/** NUL-separated pathspec payload for `--pathspec-from-file=- --pathspec-file-nul`. */
export function pathspecStdin(relPaths: readonly string[]): Buffer {
  return Buffer.from(relPaths.map(literalPathspec).join('\0'), 'utf8');
}

function toBuffer(value: string | Buffer | undefined): Buffer {
  if (value === undefined) return Buffer.alloc(0);
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function numericExitCode(err: unknown): number {
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'number') return code;
  // A timeout kill surfaces as a signal with a null code.
  return 1;
}
