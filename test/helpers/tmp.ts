import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** A throwaway workspace plus its own extension-storage directory. */
export interface TempWorkspace {
  root: string;
  storage: string;
  file(relPath: string, content: string | Buffer): Promise<void>;
  read(relPath: string): Promise<Buffer>;
  readText(relPath: string): Promise<string>;
  remove(relPath: string): Promise<void>;
  exists(relPath: string): Promise<boolean>;
  mkdir(relPath: string): Promise<void>;
  abs(relPath: string): string;
  cleanup(): Promise<void>;
}

export async function makeTempWorkspace(prefix = 'lfct-test-'): Promise<TempWorkspace> {
  // realpath because macOS hands out /var/... which is a symlink to /private/var,
  // and git reports the resolved form. Comparing the two would fail spuriously.
  const base = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), prefix));
  const root = path.join(base, 'workspace');
  const storage = path.join(base, 'storage');
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(storage, { recursive: true });

  const abs = (relPath: string) => path.join(root, ...relPath.split('/'));

  return {
    root,
    storage,
    abs,
    async file(relPath, content) {
      const target = abs(relPath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
    },
    async read(relPath) {
      return fs.readFile(abs(relPath));
    },
    async readText(relPath) {
      return fs.readFile(abs(relPath), 'utf8');
    },
    async remove(relPath) {
      await fs.rm(abs(relPath), { recursive: true, force: true });
    },
    async exists(relPath) {
      try {
        await fs.access(abs(relPath));
        return true;
      } catch {
        return false;
      }
    },
    async mkdir(relPath) {
      await fs.mkdir(abs(relPath), { recursive: true });
    },
    async cleanup() {
      await fs.rm(base, { recursive: true, force: true });
    },
  };
}

/** Runs git against a real repository. Used to *create* fixtures, never by the extension. */
export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      LC_ALL: 'C',
    },
  });
  return stdout;
}

/** Initializes the workspace as a normal git repository with one commit. */
export async function initRealRepo(root: string): Promise<void> {
  await git(root, ['-c', 'init.defaultBranch=main', 'init', '--quiet']);
  await git(root, ['config', 'user.name', 'Test']);
  await git(root, ['config', 'user.email', 'test@example.com']);
  await git(root, ['config', 'commit.gpgsign', 'false']);
}

export const GIT_VERSION = { major: 2, minor: 39, patch: 0, raw: 'git version 2.39.0' };

/** Resolves the real git version so tests exercise the same gates the extension does. */
export async function realGitVersion(): Promise<typeof GIT_VERSION> {
  const { stdout } = await execFileAsync('git', ['--version']);
  const m = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(stdout);
  if (!m) return GIT_VERSION;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: m[3] ? Number(m[3]) : 0,
    raw: stdout.trim(),
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
