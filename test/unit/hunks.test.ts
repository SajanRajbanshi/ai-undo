import { describe, expect, it } from 'vitest';

import {
  HunkStaleError,
  acceptHunkIntoBaseline,
  acceptHunksIntoBaseline,
  computeHunks,
  findHunk,
  hunksCoveredBy,
  hunkStats,
  joinLines,
  revertAll,
  revertHunk,
  sameTextIgnoringEncoding,
  splitLines,
} from '../../src/diff/hunks';

/**
 * This module's output is written straight into the user's files, so the bar
 * here is higher than "the diff looks right". The round-trip property at the
 * bottom is the one that actually matters: reverting every hunk must reproduce
 * the baseline byte for byte, for arbitrary content.
 */

describe('splitLines / joinLines are exact inverses', () => {
  const cases = [
    '',
    '\n',
    'a',
    'a\n',
    'a\nb',
    'a\nb\n',
    '\n\n\n',
    'a\r\nb\r\n',
    'trailing spaces   \n',
    '日本語\n🎉\n',
  ];
  for (const text of cases) {
    it(`round-trips ${JSON.stringify(text)}`, () => {
      expect(joinLines(splitLines(text))).toBe(text);
    });
  }
});

describe('computeHunks', () => {
  it('returns nothing for identical content', () => {
    expect(computeHunks('a\nb\n', 'a\nb\n')).toEqual([]);
  });

  it('locates an added line in current-document coordinates', () => {
    const hunks = computeHunks('one\ntwo\n', 'one\ninserted\ntwo\n');
    expect(hunks).toHaveLength(1);
    expect(hunks[0].addedLines).toEqual([1]); // 0-based
    expect(hunks[0].deletions).toEqual([]);
  });

  it('anchors a deletion to the line it follows', () => {
    const hunks = computeHunks('one\ngone\ntwo\n', 'one\ntwo\n');
    expect(hunks[0].addedLines).toEqual([]);
    expect(hunks[0].deletions).toEqual([{ afterLine: 0, markerLine: 0, lines: ['gone'] }]);
  });

  it('handles a deletion at the very top of the file', () => {
    const hunks = computeHunks('first\none\n', 'one\n');
    expect(hunks[0].deletions).toEqual([{ afterLine: -1, markerLine: 0, lines: ['first'] }]);
  });

  it('represents a modification as a deletion plus an addition', () => {
    const hunks = computeHunks('one\ntwo\nthree\n', 'one\nTWO\nthree\n');
    expect(hunks[0].addedLines).toEqual([1]);
    expect(hunks[0].deletions).toEqual([{ afterLine: 0, markerLine: 0, lines: ['two'] }]);
    expect(hunkStats(hunks[0])).toEqual({ added: 1, removed: 1 });
  });

  it('separates distant changes into multiple hunks', () => {
    const baseline = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const current = baseline.replace('line 2', 'CHANGED 2').replace('line 35', 'CHANGED 35');
    const hunks = computeHunks(baseline, current);
    expect(hunks).toHaveLength(2);
    expect(hunks[0].index).toBe(0);
    expect(hunks[1].index).toBe(1);
  });

  it('never emits the no-newline marker as content', () => {
    const hunks = computeHunks('one\ntwo\n', 'one\ntwo');
    for (const hunk of hunks) {
      expect(hunk.lines.some((l) => l.text.includes('No newline'))).toBe(false);
    }
  });
});

/**
 * The granularity is what decides whether a change gets its own Accept/Reject
 * control, so it is behaviour rather than an implementation detail. Three
 * context lines used to fold a deletion into a nearby addition's hunk, leaving
 * the deletion with a marker and no controls at all.
 */
describe('computeHunks granularity', () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`);

  it('keeps an addition and a nearby deletion as separate hunks', () => {
    const baseline = lines(12).join('\n') + '\n';
    const current = lines(12)
      .flatMap((l, i) => (i === 3 ? [l, 'INSERTED'] : l))
      .filter((l) => l !== 'line 8')
      .join('\n') + '\n';

    const hunks = computeHunks(baseline, current);
    expect(hunks).toHaveLength(2);

    // The addition anchors on the added line; the deletion gets its own anchor
    // rather than being swallowed by the addition's hunk.
    expect(hunkStats(hunks[0])).toEqual({ added: 1, removed: 0 });
    expect(hunkStats(hunks[1])).toEqual({ added: 0, removed: 1 });
    expect(hunks[1].anchorLine).not.toBe(hunks[0].anchorLine);
  });

  it('combines a deletion and the addition that replaces it into one hunk', () => {
    const baseline = 'a\nold one\nold two\nb\n';
    const current = 'a\nnew one\nnew two\nb\n';

    const hunks = computeHunks(baseline, current);
    expect(hunks).toHaveLength(1);
    expect(hunkStats(hunks[0])).toEqual({ added: 2, removed: 2 });
    expect(hunks[0].addedLines).toEqual([1, 2]);
    expect(hunks[0].deletions).toEqual([
      { afterLine: 0, markerLine: 0, lines: ['old one', 'old two'] },
    ]);
  });

  it('splits two modifications separated by a single unchanged line', () => {
    const hunks = computeHunks('a\nb\nc\n', 'A\nb\nC\n');
    expect(hunks).toHaveLength(2);
    for (const hunk of hunks) {
      expect(hunkStats(hunk)).toEqual({ added: 1, removed: 1 });
    }
  });

  it('anchors a deletion-only hunk on the line its marker is drawn on', () => {
    const hunks = computeHunks('one\ngone\ntwo\n', 'one\ntwo\n');
    expect(hunks[0].deletions[0].afterLine).toBe(0);
    // Same line as the marker, so the controls render directly above it rather
    // than below their own marker.
    expect(hunks[0].anchorLine).toBe(0);
  });
});

/**
 * Two hunks sharing an anchor stack two indistinguishable sets of Reject/Keep
 * controls on one line; two deletion groups sharing a marker line means one of
 * them is never drawn. Distinct groups normally have distinct `afterLine`
 * values, with one exception — a block removed from above line 0 has nothing to
 * hang off and takes line 0, which a block removed *after* line 0 also wants.
 */
describe('deletion markers never share a line', () => {
  it('separates a deletion above line 0 from one after it', () => {
    const hunks = computeHunks('l0\nl1\nl3\nl10', 'l1\nl10');
    expect(hunks).toHaveLength(2);

    expect(hunks[0].deletions[0]).toMatchObject({ afterLine: -1, markerLine: 0, lines: ['l0'] });
    // Would also be line 0 without the resolution, hiding one of the two.
    expect(hunks[1].deletions[0]).toMatchObject({ afterLine: 0, markerLine: 1, lines: ['l3'] });
    expect(hunks[0].anchorLine).not.toBe(hunks[1].anchorLine);
  });

  it('holds across randomized edits', () => {
    let seed = 987654321;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    for (let trial = 0; trial < 500; trial++) {
      const size = 1 + Math.floor(rand() * 20);
      const base = Array.from({ length: size }, (_, i) => `l${i}`);
      const cur: string[] = [];
      for (const line of base) {
        const roll = rand();
        if (roll < 0.2) continue;
        if (roll < 0.35) cur.push(line, 'INS');
        else if (roll < 0.5) cur.push(line.toUpperCase());
        else if (roll < 0.58) cur.push('INS', line);
        else cur.push(line);
      }
      const nl = rand() < 0.5;
      const baseline = base.join('\n') + (nl ? '\n' : '');
      const current = cur.join('\n') + (nl ? '\n' : '');
      if (baseline === current) continue;

      const hunks = computeHunks(baseline, current);
      const anchors = new Set<number>();
      const markers = new Set<number>();
      for (const hunk of hunks) {
        expect(anchors.has(hunk.anchorLine), `trial ${trial}: anchor reused`).toBe(false);
        anchors.add(hunk.anchorLine);
        for (const group of hunk.deletions) {
          expect(markers.has(group.markerLine), `trial ${trial}: marker reused`).toBe(false);
          markers.add(group.markerLine);
        }
      }
    }
  });
});

/**
 * Maps a change as VS Code's peek displays it onto our own hunks. The zero-end
 * convention is the trap: `originalEndLineNumber === 0` means insertion and
 * `modifiedEndLineNumber === 0` means deletion, with the matching start being
 * the line the empty range sits *after*. Reading it wrong would act on the
 * wrong lines, and would do so self-consistently — which is exactly why the
 * change only selects hunks and never splices anything itself.
 */
describe('hunksCoveredBy', () => {
  const baseline = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n';

  it('selects the hunk for a pure insertion', () => {
    const current = baseline.replace('line 5\n', 'line 5\nINSERTED\n');
    const hunks = computeHunks(baseline, current);
    // VS Code: inserted after original line 6, occupying modified line 7.
    const covered = hunksCoveredBy(hunks, {
      originalStartLineNumber: 6,
      originalEndLineNumber: 0,
      modifiedStartLineNumber: 7,
      modifiedEndLineNumber: 7,
    });
    expect(covered).toHaveLength(1);
    expect(hunkStats(covered[0])).toEqual({ added: 1, removed: 0 });
  });

  it('selects the hunk for a pure deletion', () => {
    const current = baseline.replace('line 5\n', '');
    const hunks = computeHunks(baseline, current);
    // VS Code: original line 6 deleted; in the modified file the gap sits after
    // line 5, so modifiedEndLineNumber is 0.
    const covered = hunksCoveredBy(hunks, {
      originalStartLineNumber: 6,
      originalEndLineNumber: 6,
      modifiedStartLineNumber: 5,
      modifiedEndLineNumber: 0,
    });
    expect(covered).toHaveLength(1);
    expect(hunkStats(covered[0])).toEqual({ added: 0, removed: 1 });
  });

  it('selects the hunk for a modification', () => {
    const current = baseline.replace('line 5\n', 'CHANGED\n');
    const hunks = computeHunks(baseline, current);
    const covered = hunksCoveredBy(hunks, {
      originalStartLineNumber: 6,
      originalEndLineNumber: 6,
      modifiedStartLineNumber: 6,
      modifiedEndLineNumber: 6,
    });
    expect(covered).toHaveLength(1);
    expect(hunkStats(covered[0])).toEqual({ added: 1, removed: 1 });
  });

  /**
   * VS Code merges nearby edits into one displayed change while we split at
   * every unchanged line, so one click can legitimately cover several hunks.
   * They must go together — acting on only one would leave the peek showing a
   * change the user believes they already handled.
   */
  it('selects every hunk a single displayed change spans', () => {
    const current = baseline.replace('line 5\n', 'CHANGED 5\n').replace('line 7\n', 'CHANGED 7\n');
    const hunks = computeHunks(baseline, current);
    expect(hunks).toHaveLength(2);

    const covered = hunksCoveredBy(hunks, {
      originalStartLineNumber: 6,
      originalEndLineNumber: 8,
      modifiedStartLineNumber: 6,
      modifiedEndLineNumber: 8,
    });
    expect(covered).toHaveLength(2);
  });

  it('selects nothing for a change that covers no hunk', () => {
    const current = baseline.replace('line 5\n', 'CHANGED\n');
    const hunks = computeHunks(baseline, current);
    const covered = hunksCoveredBy(hunks, {
      originalStartLineNumber: 18,
      originalEndLineNumber: 18,
      modifiedStartLineNumber: 18,
      modifiedEndLineNumber: 18,
    });
    expect(covered).toEqual([]);
  });

  it('reverting the selection is the same as reverting that one change', () => {
    const current = baseline.replace('line 5\n', '');
    const hunks = computeHunks(baseline, current);
    const covered = hunksCoveredBy(hunks, {
      originalStartLineNumber: 6,
      originalEndLineNumber: 6,
      modifiedStartLineNumber: 5,
      modifiedEndLineNumber: 0,
    });
    // The only change in the file, so reverting it restores the baseline byte
    // for byte — proof the mapping landed on the right lines.
    expect(revertAll(current, covered)).toBe(baseline);
  });
});

describe('acceptHunksIntoBaseline', () => {
  it('advances past several hunks at once', () => {
    const baseline = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const current = baseline.replace('line 5\n', 'CHANGED 5\n').replace('line 7\n', 'CHANGED 7\n');
    const hunks = computeHunks(baseline, current);
    expect(hunks).toHaveLength(2);

    expect(acceptHunksIntoBaseline(baseline, hunks)).toBe(current);
  });

  it('leaves hunks it was not given still pending', () => {
    const baseline = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const current = baseline.replace('line 2\n', 'CHANGED 2\n').replace('line 35\n', 'CHANGED 35\n');
    const hunks = computeHunks(baseline, current);

    const advanced = acceptHunksIntoBaseline(baseline, [hunks[0]]);
    expect(advanced).toContain('CHANGED 2');
    expect(advanced).not.toContain('CHANGED 35');
    expect(computeHunks(advanced, current)).toHaveLength(1);
  });
});

describe('hunk ids', () => {
  it('survive a neighbouring hunk being accepted', () => {
    const baseline = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const current = baseline.replace('line 2\n', 'CHANGED 2\n').replace('line 20\n', 'CHANGED 20\n');

    const before = computeHunks(baseline, current);
    expect(before).toHaveLength(2);

    // Accept the first; the second keeps its identity even though its baseline
    // coordinates have moved. A CodeLens painted before this still resolves.
    const advanced = acceptHunkIntoBaseline(baseline, before[0]);
    const after = computeHunks(advanced, current);

    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before[1].id);
    expect(findHunk(after, before[1].id)).toBe(after[0]);
    expect(findHunk(after, before[0].id)).toBeUndefined();
  });

  it('distinguishes two identical changes in the same file', () => {
    const baseline = 'x\na\nb\nc\nd\ne\nf\ng\nx\n';
    const current = 'X\na\nb\nc\nd\ne\nf\ng\nX\n';
    const hunks = computeHunks(baseline, current);

    expect(hunks).toHaveLength(2);
    expect(hunks[0].id).not.toBe(hunks[1].id);
  });
});

/**
 * The failure these guard against is silent: a control painted before an Accept
 * moved the baseline still points at coordinates that now hold something else.
 * Applying it there would either corrupt the file or discard the change that
 * was already accepted, so both operations refuse.
 */
describe('stale hunks are refused, not applied', () => {
  it('revertHunk refuses when the target lines have changed', () => {
    const hunks = computeHunks('one\ntwo\nthree\n', 'one\nTWO\nthree\n');
    expect(() => revertHunk('one\nSOMETHING ELSE\nthree\n', hunks[0])).toThrow(HunkStaleError);
  });

  it('acceptHunkIntoBaseline refuses when the baseline has already moved', () => {
    const baseline = 'one\ntwo\nthree\n';
    const current = 'one\nTWO\nthree\n';
    const hunk = computeHunks(baseline, current)[0];

    // The baseline already contains this hunk: accepting it again would splice
    // over the wrong line rather than being a harmless no-op.
    const advanced = acceptHunkIntoBaseline(baseline, hunk);
    expect(() => acceptHunkIntoBaseline(advanced, hunk)).toThrow(HunkStaleError);
  });

  it('accepting every hunk in any order still reaches the current file', () => {
    const baseline = Array.from({ length: 25 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const current = Array.from({ length: 25 }, (_, i) =>
      i % 4 === 0 ? `CHANGED ${i}` : `line ${i}`,
    ).join('\n') + '\n';

    // Front to back, recomputing each time — exactly what clicking Keep down
    // the file does. The last accept must land on the current file exactly, or
    // the file never leaves the pending list.
    let text = baseline;
    let guard = 0;
    for (;;) {
      const hunks = computeHunks(text, current);
      if (hunks.length === 0) break;
      expect(guard++).toBeLessThan(25);
      text = acceptHunkIntoBaseline(text, hunks[0]);
    }
    expect(text).toBe(current);
  });
});

describe('revertHunk', () => {
  it('undoes a single modification', () => {
    const baseline = 'one\ntwo\nthree\n';
    const current = 'one\nTWO\nthree\n';
    const hunks = computeHunks(baseline, current);
    expect(revertHunk(current, hunks[0])).toBe(baseline);
  });

  it('undoes an addition', () => {
    const baseline = 'one\ntwo\n';
    const current = 'one\ninserted\ntwo\n';
    expect(revertHunk(current, computeHunks(baseline, current)[0])).toBe(baseline);
  });

  it('undoes a deletion', () => {
    const baseline = 'one\ngone\ntwo\n';
    const current = 'one\ntwo\n';
    expect(revertHunk(current, computeHunks(baseline, current)[0])).toBe(baseline);
  });

  it('leaves other hunks untouched', () => {
    const baseline = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const current = baseline.replace('line 2', 'CHANGED 2').replace('line 35', 'CHANGED 35');
    const hunks = computeHunks(baseline, current);

    const afterFirst = revertHunk(current, hunks[0]);

    expect(afterFirst).toContain('line 2');
    expect(afterFirst).not.toContain('CHANGED 2');
    // The far-away change must survive intact.
    expect(afterFirst).toContain('CHANGED 35');
  });

  it('restores a missing trailing newline', () => {
    const baseline = 'one\ntwo\n';
    const current = 'one\ntwo';
    expect(revertHunk(current, computeHunks(baseline, current)[0])).toBe(baseline);
  });

  it('removes a trailing newline the baseline did not have', () => {
    const baseline = 'one\ntwo';
    const current = 'one\ntwo\n';
    expect(revertHunk(current, computeHunks(baseline, current)[0])).toBe(baseline);
  });

  it('preserves CRLF line endings', () => {
    const baseline = 'one\r\ntwo\r\nthree\r\n';
    const current = 'one\r\nTWO\r\nthree\r\n';
    expect(revertHunk(current, computeHunks(baseline, current)[0])).toBe(baseline);
  });

  it('throws rather than corrupting when the file moved underneath it', () => {
    const hunks = computeHunks('one\ntwo\nthree\n', 'one\nTWO\nthree\n');
    expect(() => revertHunk('short\n', hunks[0])).toThrow(/spans lines/);
  });
});

describe('acceptHunkIntoBaseline', () => {
  it('advances the baseline by exactly one hunk', () => {
    const baseline = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const current = baseline.replace('line 2', 'CHANGED 2').replace('line 35', 'CHANGED 35');
    const hunks = computeHunks(baseline, current);

    const advanced = acceptHunkIntoBaseline(baseline, hunks[0]);

    expect(advanced).toContain('CHANGED 2');
    expect(advanced).not.toContain('CHANGED 35');

    // The remaining hunk against the new baseline is exactly the other change.
    const remaining = computeHunks(advanced, current);
    expect(remaining).toHaveLength(1);
    expect(hunkStats(remaining[0])).toEqual({ added: 1, removed: 1 });
  });

  it('accepting every hunk yields the current file', () => {
    const baseline = 'a\nb\nc\nd\ne\n';
    const current = 'a\nB\nc\nD\nE\n';
    const hunks = computeHunks(baseline, current);

    let text = baseline;
    // Back to front so earlier coordinates stay valid.
    for (const hunk of [...hunks].sort((a, b) => b.oldStart - a.oldStart)) {
      text = acceptHunkIntoBaseline(text, hunk);
    }
    expect(text).toBe(current);
  });
});

/**
 * This decides whether a fully reviewed file may be settled outright. Too
 * permissive and Accept swallows a write the user never saw, so the negative
 * cases matter more than the positive ones.
 */
describe('sameTextIgnoringEncoding', () => {
  it('ignores a byte-order mark', () => {
    expect(sameTextIgnoringEncoding('\uFEFFa\nb\n', 'a\nb\n')).toBe(true);
  });

  it('ignores the choice of line terminator', () => {
    expect(sameTextIgnoringEncoding('a\r\nb\r\n', 'a\nb\n')).toBe(true);
  });

  it('ignores both at once', () => {
    expect(sameTextIgnoringEncoding('\uFEFFa\r\nb\r\n', 'a\nb\n')).toBe(true);
  });

  it('rejects a changed line', () => {
    expect(sameTextIgnoringEncoding('a\r\nb\r\n', 'a\nB\n')).toBe(false);
  });

  it('rejects an added line', () => {
    expect(sameTextIgnoringEncoding('a\nb\n', 'a\nb\nc\n')).toBe(false);
  });

  it('rejects a changed trailing newline', () => {
    expect(sameTextIgnoringEncoding('a\nb\n', 'a\nb')).toBe(false);
  });

  it('rejects a mark that is not at the start', () => {
    expect(sameTextIgnoringEncoding('a\n\uFEFFb\n', 'a\nb\n')).toBe(false);
  });
});

describe('round-trip property — reverting every hunk reproduces the baseline', () => {
  const scenarios: [string, string, string][] = [
    ['single modification', 'one\ntwo\nthree\n', 'one\nTWO\nthree\n'],
    ['pure addition', 'one\ntwo\n', 'one\nA\nB\ntwo\n'],
    ['pure deletion', 'one\nA\nB\ntwo\n', 'one\ntwo\n'],
    ['append at end', 'one\n', 'one\ntwo\nthree\n'],
    ['prepend at start', 'one\n', 'zero\none\n'],
    ['empty baseline', '', 'brand\nnew\nfile\n'],
    ['emptied file', 'was\nhere\n', ''],
    ['no trailing newline both', 'a\nb', 'a\nB'],
    ['trailing newline added', 'a\nb', 'a\nb\n'],
    ['trailing newline removed', 'a\nb\n', 'a\nb'],
    ['CRLF throughout', 'a\r\nb\r\nc\r\n', 'a\r\nB\r\nc\r\n'],
    ['blank lines', 'a\n\n\nb\n', 'a\n\nb\n'],
    ['unicode', 'café\n日本\n', 'café\n🎉\n日本\n'],
    ['whitespace only change', 'a\n  b\n', 'a\n\tb\n'],
    [
      'many scattered changes',
      Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n') + '\n',
      Array.from({ length: 100 }, (_, i) => (i % 7 === 0 ? `CHANGED ${i}` : `line ${i}`)).join(
        '\n',
      ) + '\n',
    ],
    [
      'interleaved adds and deletes',
      Array.from({ length: 60 }, (_, i) => `l${i}`).join('\n') + '\n',
      Array.from({ length: 60 }, (_, i) => `l${i}`)
        .filter((_, i) => i % 5 !== 0)
        .flatMap((l, i) => (i % 9 === 0 ? [l, `EXTRA ${i}`] : [l]))
        .join('\n') + '\n',
    ],
  ];

  for (const [name, baseline, current] of scenarios) {
    it(name, () => {
      const hunks = computeHunks(baseline, current);
      expect(revertAll(current, hunks)).toBe(baseline);
    });
  }

  it('holds for randomized edits', () => {
    // Deterministic pseudo-random so a failure is reproducible.
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    for (let trial = 0; trial < 200; trial++) {
      const size = 5 + Math.floor(rand() * 40);
      const baselineLines = Array.from({ length: size }, (_, i) => `line-${i}-${'x'.repeat(i % 5)}`);
      const currentLines: string[] = [];
      for (const line of baselineLines) {
        const roll = rand();
        if (roll < 0.15) continue; // delete
        if (roll < 0.3) currentLines.push(line, `inserted-${rand().toFixed(4)}`);
        else if (roll < 0.45) currentLines.push(line.toUpperCase());
        else currentLines.push(line);
      }
      const trailing = rand() < 0.5;
      const baseline = baselineLines.join('\n') + (trailing ? '\n' : '');
      const current = currentLines.join('\n') + (trailing ? '\n' : '');

      const hunks = computeHunks(baseline, current);
      expect(revertAll(current, hunks), `trial ${trial} failed`).toBe(baseline);
    }
  });
});
