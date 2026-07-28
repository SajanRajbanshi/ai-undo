import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Path normalization. Two invariants hold everywhere above this module:
 *
 *  - "relPath" always means a workspace-relative POSIX path with no leading
 *    slash and no `./` prefix. That is exactly what git wants on stdin and what
 *    the SCM layer keys its maps by.
 *  - "absPath" always means a platform-native absolute path.
 */

/**
 * macOS (APFS/HFS+ by default) and Windows are case-insensitive, so the
 * expected-write and suppression maps must compare case-insensitively or a save
 * to `App.ts` will not cancel the watcher event for `app.ts`.
 *
 * This uses the platform default rather than probing the filesystem. A
 * case-sensitive volume on macOS therefore over-matches, which can only ever
 * cause a missed detection for two files whose paths differ solely in case —
 * the same imperfection E12 already documents for case-only renames.
 */
export const CASE_INSENSITIVE_FS = os.platform() === 'darwin' || os.platform() === 'win32';

/** Key for maps that must behave like the filesystem does. */
export function pathKey(absPath: string): string {
  const normalized = path.normalize(absPath);
  return CASE_INSENSITIVE_FS ? normalized.toLowerCase() : normalized;
}

export function toPosix(p: string): string {
  return path.sep === '\\' ? p.split(path.sep).join('/') : p;
}

export function fromPosix(p: string): string {
  return path.sep === '\\' ? p.split('/').join(path.sep) : p;
}

/**
 * Workspace-relative POSIX path, or `undefined` when `absPath` is outside
 * `root`. Returning undefined rather than a `../` path is deliberate: every
 * caller treats "outside the workspace" as "not our business".
 */
export function toRelPosix(root: string, absPath: string): string | undefined {
  const rel = path.relative(root, absPath);
  if (rel === '') return undefined;
  if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return toPosix(rel);
}

export function toAbs(root: string, relPosix: string): string {
  return path.resolve(root, fromPosix(relPosix));
}

/** True when `child` is `parent` itself or lives underneath it. */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function segments(relPosix: string): string[] {
  return relPosix.split('/').filter((s) => s.length > 0);
}

export function basename(relPosix: string): string {
  const i = relPosix.lastIndexOf('/');
  return i === -1 ? relPosix : relPosix.slice(i + 1);
}

export function dirnamePosix(relPosix: string): string {
  const i = relPosix.lastIndexOf('/');
  return i === -1 ? '' : relPosix.slice(0, i);
}
