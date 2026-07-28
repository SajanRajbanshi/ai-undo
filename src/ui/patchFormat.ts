/**
 * Presentation for the unified patch view (§7.5.1 surface 1).
 *
 * `git diff` output is a *transport* format — it carries everything `git apply`
 * needs to locate a change in a file it has never seen. This view is the
 * opposite situation: one known file, already open, in a tab that says its
 * name. So the blob hashes, the `a/` and `b/` paths, and the `@@ -259,15
 * +261,32 @@` arithmetic are all machine syntax with no reader value.
 *
 * The `+`, `-` and space prefixes go the same way, and that one is what buys
 * syntax highlighting. A document whose every line starts with `+` cannot be
 * tokenized as TypeScript; strip the column and each line is real source again,
 * so the file's own grammar applies and the view stops looking like plain text.
 * It also means copying a line out of the diff yields code rather than code
 * with a stray `+` on the front.
 *
 * Everything the prefixes and the `@@` header used to carry moves into the
 * `lines` array, to be drawn as decorations instead: the change kind as a
 * full-line background, and the real line number in the margin.
 */

/** Lines git emits to locate the file. Only ever appear before the first `@@`. */
const FILE_HEADER = [
  /^diff --git /,
  /^index /,
  /^--- /,
  /^\+\+\+ /,
  /^(new|deleted) file mode /,
  /^(old|new) mode /,
  /^similarity index /,
  /^rename (from|to) /,
];

/**
 * `@@ -oldStart,oldLines +newStart,newLines @@ trailing context`. The counts are
 * optional; git omits them for a single-line range.
 */
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** `meta` is anything that is not a line of the file: separators, git's notices. */
export type PatchLineKind = 'context' | 'added' | 'removed' | 'meta';

export interface PatchLine {
  kind: PatchLineKind;
  /**
   * The line's number in whichever file it exists in — the **baseline** for a
   * removal, the **file on disk** for an addition and for context — or `null`
   * for `meta`. The two files diverge, so they are counted separately.
   */
  number: number | null;
}

export interface FormattedPatch {
  text: string;
  /** One entry per line of `text`. */
  lines: PatchLine[];
}

export function formatPatchForDisplay(raw: string): FormattedPatch {
  const text: string[] = [];
  const lines: PatchLine[] = [];

  const emit = (line: string, kind: PatchLineKind, number: number | null) => {
    text.push(line);
    lines.push({ kind, number });
  };

  let seenHunk = false;
  let oldLine = 0;
  let newLine = 0;

  for (const line of raw.split('\n')) {
    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      // A blank line between hunks, and nothing above the first: the numbers
      // themselves are what tell the reader a stretch of file was skipped.
      if (seenHunk) emit('', 'meta', null);
      seenHunk = true;
      continue;
    }

    // Only strip file headers *before* the first hunk, which is the only place
    // git puts them. Afterwards a line beginning `--- ` is a removed line whose
    // content happens to start with `-- `, and dropping it would silently hide
    // part of the change.
    if (!seenHunk) {
      if (FILE_HEADER.some((re) => re.test(line))) continue;
      emit(line, 'meta', null); // A binary notice, or one of the `#` placeholders.
      continue;
    }

    if (line.startsWith('+')) emit(line.slice(1), 'added', newLine++);
    else if (line.startsWith('-')) emit(line.slice(1), 'removed', oldLine++);
    else if (line.startsWith('\\')) emit(line, 'meta', null); // `\ No newline at end of file`
    else if (line === '') emit(line, 'meta', null); // Trailing element from the final newline.
    else {
      // Context: present in both files, numbered by the one on disk.
      emit(line.slice(1), 'context', newLine);
      oldLine++;
      newLine++;
    }
  }

  return { text: text.join('\n'), lines };
}
