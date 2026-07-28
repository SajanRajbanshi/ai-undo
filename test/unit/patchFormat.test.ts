import { describe, expect, it } from 'vitest';

import { formatPatchForDisplay, type PatchLineKind } from '../../src/ui/patchFormat';

/**
 * This rewrites what the user reads, so the bar is that it may only ever remove
 * *machine syntax*. Dropping a real added or removed line would hide part of a
 * change in the one view whose entire job is showing the change completely — a
 * silent failure, and the worst kind this view can have.
 *
 * Since the `+`/`-` prefixes are stripped so the file's own grammar can
 * highlight the lines, "which lines changed" is asserted through `lines[i].kind`
 * rather than through the text.
 */

/** Text paired with its kind and number, which is what the view actually renders. */
const rows = (raw: string) => {
  const { text, lines } = formatPatchForDisplay(raw);
  return text.split('\n').map((t, i) => [lines[i].kind, lines[i].number, t] as const);
};

const ofKind = (raw: string, kind: PatchLineKind) =>
  rows(raw)
    .filter(([k]) => k === kind)
    .map(([, , t]) => t);

const patch = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 3434ee9..acfa26c 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -85,6 +85,8 @@ export class Thing {',
  ' context one',
  '-removed one',
  '+added one',
  '@@ -259,15 +261,32 @@ export class Thing {',
  ' context two',
  '+added two',
  '',
].join('\n');

describe('formatPatchForDisplay', () => {
  it('drops the file-locating header and the @@ ranges entirely', () => {
    const { text } = formatPatchForDisplay(patch);
    expect(text).not.toContain('diff --git');
    expect(text).not.toContain('index 3434ee9');
    expect(text).not.toContain('@@');
  });

  it('keeps every added and removed line, without its prefix', () => {
    expect(ofKind(patch, 'removed')).toEqual(['removed one']);
    expect(ofKind(patch, 'added')).toEqual(['added one', 'added two']);
    expect(ofKind(patch, 'context')).toEqual(['context one', 'context two']);
  });

  /**
   * The reason the prefixes go: a line beginning `+` cannot be tokenized as the
   * language it is, so the whole view renders as plain text.
   */
  it('leaves lines as real source, with no diff column', () => {
    const { text } = formatPatchForDisplay(
      ['@@ -1,2 +1,2 @@', '-  const a = 1;', '+  const a = 2;'].join('\n'),
    );
    expect(text.split('\n')).toEqual(['  const a = 1;', '  const a = 2;']);
  });

  /**
   * The one that would bite. A removed line reading `-- note` becomes `--- note`
   * in the patch, which is exactly the shape of a `--- a/path` file header.
   * Header stripping is therefore confined to the region before the first hunk,
   * where git actually puts them.
   */
  it('keeps changed lines whose content looks like a file header', () => {
    const tricky = [
      'diff --git a/q.sql b/q.sql',
      '--- a/q.sql',
      '+++ b/q.sql',
      '@@ -1,2 +1,2 @@',
      '--- a comment in SQL',
      '+++ a comment in SQL',
      ' select 1;',
    ].join('\n');

    expect(ofKind(tricky, 'removed')).toEqual(['-- a comment in SQL']);
    expect(ofKind(tricky, 'added')).toEqual(['++ a comment in SQL']);
  });

  it('keeps the no-newline marker as meta', () => {
    expect(
      rows(['@@ -1 +1 @@', '-one', '+one', '\\ No newline at end of file'].join('\n')),
    ).toContainEqual(['meta', null, '\\ No newline at end of file']);
  });

  it('keeps a binary notice, which has no hunk at all', () => {
    const { text } = formatPatchForDisplay(
      [
        'diff --git a/i.png b/i.png',
        'index aaa..bbb 100644',
        'Binary files a/i.png and b/i.png differ',
      ].join('\n'),
    );
    expect(text.trim()).toBe('Binary files a/i.png and b/i.png differ');
  });

  it('passes through the no-differences placeholder', () => {
    const text = '# src/app.ts\n# No differences against the baseline.\n';
    expect(formatPatchForDisplay(text).text).toBe(text);
  });

  it('leaves an empty patch empty', () => {
    expect(formatPatchForDisplay('').text).toBe('');
  });

  it('separates hunks with a blank line, and nothing above the first', () => {
    const out = rows(patch);
    expect(out[0]).toEqual(['context', 85, 'context one']);
    expect(out[3]).toEqual(['meta', null, '']);
  });

  it('produces exactly one entry per line of text', () => {
    const { text, lines } = formatPatchForDisplay(patch);
    expect(lines).toHaveLength(text.split('\n').length);
  });
});

/**
 * The numbers are what replaced the `@@` header, so they have to be right. A
 * removed line is numbered in the **baseline** and an added line in the **file
 * on disk** — the two diverge, so one running counter would drift the moment a
 * hunk is not a one-for-one replacement.
 */
describe('formatPatchForDisplay line numbers', () => {
  it('numbers context, removals and additions from the right file', () => {
    expect(
      rows(
        ['@@ -10,4 +10,5 @@', ' ctx a', '-gone', '+new one', '+new two', ' ctx b'].join('\n'),
      ),
    ).toEqual([
      ['context', 10, 'ctx a'],
      ['removed', 11, 'gone'], // line 11 of the baseline
      ['added', 11, 'new one'], // line 11 of the file on disk
      ['added', 12, 'new two'],
      ['context', 13, 'ctx b'],
    ]);
  });

  it('keeps the two files independent when a hunk only deletes', () => {
    expect(rows(['@@ -5,4 +5,2 @@', ' ctx', '-a', '-b', ' after'].join('\n'))).toEqual([
      ['context', 5, 'ctx'],
      ['removed', 6, 'a'],
      ['removed', 7, 'b'],
      // Two lines gone, so on disk this follows line 5 directly.
      ['context', 6, 'after'],
    ]);
  });

  it('restarts from each hunk header rather than running on', () => {
    expect(
      rows(['@@ -1,1 +1,1 @@', ' first', '@@ -200,1 +260,1 @@', ' later'].join('\n')),
    ).toEqual([
      ['context', 1, 'first'],
      ['meta', null, ''],
      ['context', 260, 'later'],
    ]);
  });
});
