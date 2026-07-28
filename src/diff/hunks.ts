import { structuredPatch } from 'diff';

/**
 * Hunk computation and splicing for the live inline diff (§16, pulled forward).
 *
 * This is the highest-risk code in the extension: `revertHunk` output is written
 * straight into the user's open buffer, so a splice that is off by one corrupts
 * a file rather than merely displaying it wrongly. Everything here is pure and
 * exhaustively unit tested, and `revertAll` exists specifically so tests can
 * assert the round-trip property — reverting every hunk must reproduce the
 * baseline byte for byte.
 */

export type DiffLineType = 'context' | 'add' | 'del';

export interface DiffLine {
  type: DiffLineType;
  text: string;
}

/** A run of removed lines, anchored to where it sits in the current document. */
export interface DeletionGroup {
  /**
   * 0-based line in the *current* document that the removed block follows.
   * -1 means the block belongs above the very first line.
   */
  afterLine: number;
  /**
   * 0-based document line the marker is drawn on, resolved so that two groups
   * do not land on the same one.
   *
   * Distinct groups always have distinct `afterLine` values — two runs removed
   * from the same gap would have been one run — with exactly one exception: a
   * block removed from above the very first line has nothing before it to hang
   * off, so it takes line 0, which is also where a block removed *after* line 0
   * would go. Only one of them can own that line, so the second moves to the
   * line after its own gap, which describes it just as truthfully.
   */
  markerLine: number;
  lines: string[];
}

export interface Hunk {
  index: number;
  /**
   * Stable across recomputation, unlike `index`.
   *
   * Accepting a hunk moves the baseline, which renumbers and re-anchors every
   * remaining hunk. A CodeLens captured before that still carries the old
   * position, so resolving a command by array index can apply the *wrong*
   * change. The id is derived from the hunk's content instead, so a control
   * that has not repainted yet still resolves to the change the user is
   * looking at — and when it genuinely cannot, it resolves to nothing rather
   * than to a neighbour.
   */
  id: string;
  /** 1-based, as in a unified patch. */
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
  /** 0-based lines in the current document that this hunk added. */
  addedLines: number[];
  deletions: DeletionGroup[];
  /** 0-based line to hang the CodeLens on. */
  anchorLine: number;

  /**
   * End-of-file bookkeeping. A hunk that reaches the end of the file also
   * decides whether that file ends with a newline, and getting this wrong
   * silently adds or drops a byte on every round trip. jsdiff reports it with a
   * `\ No newline at end of file` pseudo-line placed immediately after the line
   * it describes, which is the only reliable source for it.
   */
  oldNoEofNewline: boolean;
  newNoEofNewline: boolean;
  reachesEndOfOld: boolean;
  reachesEndOfNew: boolean;
}

export interface SplitText {
  lines: string[];
  hadTrailingNewline: boolean;
}

/**
 * Splitting and rejoining must be exactly inverse or every splice corrupts the
 * end of the file. `"a\nb\n"` is two lines with a trailing newline; `"a\nb"` is
 * two lines without one; `""` is zero lines.
 */
export function splitLines(text: string): SplitText {
  if (text === '') return { lines: [], hadTrailingNewline: false };
  const hadTrailingNewline = text.endsWith('\n');
  const body = hadTrailingNewline ? text.slice(0, -1) : text;
  return { lines: body.split('\n'), hadTrailingNewline };
}

export function joinLines(split: SplitText): string {
  if (split.lines.length === 0) return '';
  return split.lines.join('\n') + (split.hadTrailingNewline ? '\n' : '');
}

/** jsdiff emits this pseudo-line; it is metadata, never content. */
const NO_NEWLINE_MARKER = '\\ No newline at end of file';

/**
 * Zero context, deliberately.
 *
 * jsdiff's default of three context lines is right for a patch file and wrong
 * for per-hunk controls: it merges any two changes within six lines of each
 * other into one hunk. A hunk like that has a single anchor, and the anchor
 * went to the addition — so a deletion a few lines below an insertion had a red
 * marker and no Accept/Reject affordance at all.
 *
 * At zero context a hunk is exactly one contiguous run of changed lines.
 * Removed and added lines that touch — a modification of the same region — stay
 * in one hunk and are accepted or rejected together, which is what makes the
 * pairing meaningful. Runs separated by even a single unchanged line become
 * separate hunks, each with its own controls.
 */
const DEFAULT_CONTEXT = 0;

export function computeHunks(baseline: string, current: string, context = DEFAULT_CONTEXT): Hunk[] {
  if (baseline === current) return [];

  const patch = structuredPatch('baseline', 'current', baseline, current, undefined, undefined, {
    context,
  });

  const totalOldLines = splitLines(baseline).lines.length;
  const totalNewLines = splitLines(current).lines.length;
  // Two hunks in one file can be byte-identical (the same line changed the same
  // way twice). The ordinal keeps their ids apart; see `Hunk.id`.
  const seenKeys = new Map<string, number>();
  // Shared across hunks: marker lines must be unique for the whole document, and
  // hunks arrive in ascending document order. See `DeletionGroup.markerLine`.
  const usedMarkerLines = new Set<number>();

  return patch.hunks.map((raw, index) => {
    const lines: DiffLine[] = [];
    let oldNoEofNewline = false;
    let newNoEofNewline = false;

    for (const encoded of raw.lines) {
      if (encoded === NO_NEWLINE_MARKER || encoded.startsWith('\\')) {
        // The marker describes the line immediately before it. A marker after a
        // context line means neither side ends with a newline.
        const previous = lines[lines.length - 1];
        if (previous?.type === 'del') oldNoEofNewline = true;
        else if (previous?.type === 'add') newNoEofNewline = true;
        else if (previous?.type === 'context') {
          oldNoEofNewline = true;
          newNoEofNewline = true;
        }
        continue;
      }
      const marker = encoded[0];
      const text = encoded.slice(1);
      if (marker === '+') lines.push({ type: 'add', text });
      else if (marker === '-') lines.push({ type: 'del', text });
      else lines.push({ type: 'context', text });
    }

    const addedLines: number[] = [];
    const deletions: DeletionGroup[] = [];

    // Walk the hunk tracking the current document's line cursor so additions
    // and deletion anchors land on real document coordinates.
    let newCursor = raw.newStart - 1; // 0-based
    let pendingDeletion: string[] = [];

    const flushDeletion = () => {
      if (pendingDeletion.length === 0) return;
      const afterLine = newCursor - 1;
      let markerLine = Math.max(afterLine, 0);
      if (usedMarkerLines.has(markerLine)) markerLine = afterLine + 1;
      usedMarkerLines.add(markerLine);
      deletions.push({ afterLine, markerLine, lines: pendingDeletion });
      pendingDeletion = [];
    };

    for (const line of lines) {
      if (line.type === 'del') {
        pendingDeletion.push(line.text);
        continue;
      }
      flushDeletion();
      if (line.type === 'add') addedLines.push(newCursor);
      newCursor++;
    }
    flushDeletion();

    // The controls belong directly above the block they act on. For an
    // addition that is the first added line; for a pure deletion it is the same
    // line the marker is drawn on, so the controls sit immediately above their
    // own marker rather than below it — and, because `markerLine` is unique
    // document-wide, so is this, which is what keeps two hunks from stacking
    // two indistinguishable sets of controls on one line.
    const anchorLine =
      addedLines.length > 0
        ? addedLines[0]
        : deletions.length > 0
          ? deletions[0].markerLine
          : Math.max(0, raw.newStart - 1);

    const key = contentKey(lines);
    const ordinal = seenKeys.get(key) ?? 0;
    seenKeys.set(key, ordinal + 1);

    return {
      index,
      id: `${key}#${ordinal}`,
      oldStart: raw.oldStart,
      oldLines: raw.oldLines,
      newStart: raw.newStart,
      newLines: raw.newLines,
      lines,
      addedLines,
      deletions,
      anchorLine,
      oldNoEofNewline,
      newNoEofNewline,
      reachesEndOfOld: raw.oldStart - 1 + raw.oldLines === totalOldLines,
      reachesEndOfNew: raw.newStart - 1 + raw.newLines === totalNewLines,
    };
  });
}

/**
 * Identity of a hunk by what it changes, not where. Position deliberately plays
 * no part: accepting one hunk shifts every later hunk's coordinates, and an id
 * that moved with them would defeat the purpose.
 */
function contentKey(lines: readonly DiffLine[]): string {
  const removed = lines
    .filter((l) => l.type === 'del')
    .map((l) => l.text)
    .join('\n');
  const added = lines
    .filter((l) => l.type === 'add')
    .map((l) => l.text)
    .join('\n');
  return `${hash(removed)}.${removed.length}-${hash(added)}.${added.length}`;
}

/** djb2. Collisions only ever cost a "that change is no longer available". */
function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

/** Resolves a CodeLens argument back to a live hunk. Missing means stale. */
export function findHunk(hunks: readonly Hunk[], id: string): Hunk | undefined {
  return hunks.find((h) => h.id === id);
}

/** The hunk's lines as they appear in the baseline. */
export function oldSide(hunk: Hunk): string[] {
  return hunk.lines.filter((l) => l.type !== 'add').map((l) => l.text);
}

/** The hunk's lines as they appear in the current file. */
export function newSide(hunk: Hunk): string[] {
  return hunk.lines.filter((l) => l.type !== 'del').map((l) => l.text);
}

/**
 * Undo one hunk: replaces its span in `current` with the baseline's version of
 * those lines. Every other hunk is left exactly as it is.
 */
export function revertHunk(current: string, hunk: Hunk): string {
  const split = splitLines(current);
  const start = hunk.newStart - 1;
  const end = start + hunk.newLines;

  if (start < 0 || end > split.lines.length) {
    throw new HunkStaleError(
      `Hunk ${hunk.index} spans lines ${start + 1}-${end} but the file has ${split.lines.length}.`,
    );
  }
  // The span exists — but is it still *this* hunk's content? After an Accept
  // moved the baseline, a control that has not repainted yet points at lines
  // that have shifted underneath it, and splicing there would overwrite work
  // the user never asked to touch. Refuse instead.
  if (!sameLines(split.lines.slice(start, end), newSide(hunk))) {
    throw new HunkStaleError(
      `Hunk ${hunk.index} no longer matches lines ${start + 1}-${end} of the file.`,
    );
  }

  const replaced = [...split.lines.slice(0, start), ...oldSide(hunk), ...split.lines.slice(end)];

  // Only a hunk that reaches the end of the file can change how the file ends;
  // there, the baseline's ending governs.
  return joinLines({
    lines: replaced,
    hadTrailingNewline: hunk.reachesEndOfNew ? !hunk.oldNoEofNewline : split.hadTrailingNewline,
  });
}

/**
 * Advance the baseline by one hunk: returns the baseline with only this hunk's
 * change applied. Used by per-hunk Accept, which writes this content into the
 * shadow repository and never touches the work tree.
 */
export function acceptHunkIntoBaseline(baseline: string, hunk: Hunk): string {
  const split = splitLines(baseline);
  const start = hunk.oldStart - 1;
  const end = start + hunk.oldLines;

  if (start < 0 || end > split.lines.length) {
    throw new HunkStaleError(
      `Hunk ${hunk.index} spans baseline lines ${start + 1}-${end} but the baseline has ${split.lines.length}.`,
    );
  }
  // As in `revertHunk`: accepting a hunk against a baseline that has already
  // moved would drop the change that moved it, so the file would never finish
  // clearing no matter how many hunks the user accepted.
  if (!sameLines(split.lines.slice(start, end), oldSide(hunk))) {
    throw new HunkStaleError(
      `Hunk ${hunk.index} no longer matches baseline lines ${start + 1}-${end}.`,
    );
  }

  const replaced = [...split.lines.slice(0, start), ...newSide(hunk), ...split.lines.slice(end)];
  return joinLines({
    lines: replaced,
    hadTrailingNewline: hunk.reachesEndOfOld ? !hunk.newNoEofNewline : split.hadTrailingNewline,
  });
}

/**
 * Reverting every hunk must reproduce the baseline exactly. Applied back to
 * front so earlier hunks' coordinates stay valid, and asserted as a property in
 * the test suite.
 */
export function revertAll(current: string, hunks: readonly Hunk[]): string {
  let text = current;
  for (const hunk of [...hunks].sort((a, b) => b.newStart - a.newStart)) {
    text = revertHunk(text, hunk);
  }
  return text;
}

/** `acceptHunkIntoBaseline` for several hunks, back to front for the same reason. */
export function acceptHunksIntoBaseline(baseline: string, hunks: readonly Hunk[]): string {
  let text = baseline;
  for (const hunk of [...hunks].sort((a, b) => b.oldStart - a.oldStart)) {
    text = acceptHunkIntoBaseline(text, hunk);
  }
  return text;
}

/**
 * The shape VS Code hands to a `scm/change/title` command, mirroring Monaco's
 * `IChange`. Line numbers are 1-based and inclusive; a zero end means the range
 * is empty on that side, and the matching start is then the line the empty
 * range sits *after*. So `originalEndLineNumber === 0` is a pure insertion and
 * `modifiedEndLineNumber === 0` is a pure deletion.
 */
export interface LineChange {
  readonly originalStartLineNumber: number;
  readonly originalEndLineNumber: number;
  readonly modifiedStartLineNumber: number;
  readonly modifiedEndLineNumber: number;
}

/**
 * Which of our hunks a change displayed in VS Code's peek covers.
 *
 * VS Code diffs the file against our baseline with its own algorithm and its
 * own grouping, so one change in that widget can span several zero-context
 * hunks of ours. The change is therefore used only to say *where* the user
 * clicked; our own hunks do the splicing. Building a hunk out of VS Code's line
 * numbers instead would be a second implementation of the one piece of code
 * that must never be wrong — and a self-consistent one, so the content guards
 * in `revertHunk` could not catch a misreading of the convention above.
 */
export function hunksCoveredBy(hunks: readonly Hunk[], change: LineChange): Hunk[] {
  const isDeletion = change.modifiedEndLineNumber === 0;
  // 0-based, half-open. A deletion is an empty range: the gap that sits after
  // 1-based line `modifiedStartLineNumber` is 0-based index `modifiedStartLineNumber`.
  const changeStart = isDeletion
    ? change.modifiedStartLineNumber
    : change.modifiedStartLineNumber - 1;
  const changeEnd = isDeletion ? change.modifiedStartLineNumber : change.modifiedEndLineNumber;

  return hunks.filter((hunk) => {
    const start = hunk.newStart - 1;
    const end = start + hunk.newLines;
    // An empty range on either side is a point between two lines, so touching
    // counts as covering; two non-empty ranges have to genuinely overlap.
    if (start === end || changeStart === changeEnd) {
      return start <= changeEnd && changeStart <= end;
    }
    return start < changeEnd && changeStart < end;
  });
}

/**
 * Equal as text, allowing for the two things an editor can change without the
 * user seeing it: a byte-order mark, and the choice of line terminator. Any
 * difference in the lines themselves is a real change and must not pass — this
 * is what stops per-hunk Accept from settling a file over a write it never
 * showed anyone.
 */
export function sameTextIgnoringEncoding(a: string, b: string): boolean {
  const normalize = (text: string) => text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  return normalize(a) === normalize(b);
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export class HunkStaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HunkStaleError';
  }
}

/** Total added and removed line counts, for labels. */
export function hunkStats(hunk: Hunk): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of hunk.lines) {
    if (line.type === 'add') added++;
    else if (line.type === 'del') removed++;
  }
  return { added, removed };
}
