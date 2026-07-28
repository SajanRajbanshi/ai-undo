/**
 * Unified-patch helpers for the inline diff surface (§7.5.1).
 *
 * `M` and `D` patches come straight from `git diff HEAD -- <path>`. Added files
 * are generated here instead of via `git diff --no-index -- /dev/null <path>`,
 * for two reasons: `/dev/null` is not a portable argument on Windows, and this
 * way the whole path is unit-testable without a repository or a subprocess.
 */

/** Bytes inspected when deciding whether content is binary. */
const BINARY_SNIFF_BYTES = 8192;

/** Git's own heuristic: a NUL byte near the start means binary. */
export function isBinary(content: Uint8Array): boolean {
  const limit = Math.min(content.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < limit; i++) {
    if (content[i] === 0) return true;
  }
  return false;
}

export function makeAddedFilePatch(relPath: string, content: Uint8Array): string {
  const header = `diff --git a/${relPath} b/${relPath}\nnew file mode 100644\n`;

  if (content.length === 0) {
    return `${header}--- /dev/null\n+++ b/${relPath}\n`;
  }
  if (isBinary(content)) {
    return `${header}Binary files /dev/null and b/${relPath} differ\n`;
  }

  const text = Buffer.from(content).toString('utf8');
  const endsWithNewline = text.endsWith('\n');
  const lines = text.split('\n');
  if (endsWithNewline) lines.pop();

  const body = lines.map((line) => `+${line}`).join('\n');
  const noNewlineMarker = endsWithNewline ? '' : '\n\\ No newline at end of file';

  return (
    `${header}--- /dev/null\n+++ b/${relPath}\n` +
    `@@ -0,0 +1,${lines.length} @@\n` +
    `${body}${noNewlineMarker}\n`
  );
}

/**
 * §7.5 — `provideTextDocumentContent` must return a string, so binary content
 * would render as mojibake. Accept and Reject are unaffected; only the view
 * degrades, and it should say so rather than showing garbage.
 */
export function binaryPlaceholder(
  relPath: string,
  baselineBytes: number | null,
  currentBytes: number | null,
): string {
  const describe = (n: number | null) => (n === null ? 'absent' : `${formatBytes(n)}`);
  return [
    `Binary file — ${relPath}`,
    '',
    `  at baseline: ${describe(baselineBytes)}`,
    `  on disk:     ${describe(currentBytes)}`,
    '',
    'No textual diff is available for binary content.',
    'Accept and Reject still work normally from the Source Control view.',
    '',
  ].join('\n');
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
