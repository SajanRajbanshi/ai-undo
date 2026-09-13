import { describe, expect, it } from 'vitest';

import {
  planGitOperation,
  type ParkedReview,
  type WriteSnapshot,
} from '../../src/detect/ReviewParking';
import type { BaselineEntry } from '../../src/store/CheckpointStore';

/**
 * §6.8 — the decision half of a stash round trip. Object ids are stand-ins:
 * `B` the baseline before, `A` the agent's pending content, `H` what the
 * stash left on disk.
 */

const entry = (oid: string): BaselineEntry => ({ mode: '100644', oid });

/** `undefined` on disk means "could not be hashed", which is not the same as missing. */
function snapshot(
  disk: Record<string, string | null | undefined>,
  baseline: Record<string, string> = {},
): WriteSnapshot {
  return {
    paths: Object.keys(disk),
    disk: new Map(
      Object.entries(disk).filter((kv): kv is [string, string | null] => kv[1] !== undefined),
    ),
    baseline: new Map(Object.entries(baseline).map(([p, oid]) => [p, entry(oid)])),
  };
}

function observed(o: Record<string, string | null>): Map<string, { oid: string | null }> {
  return new Map(Object.entries(o).map(([p, oid]) => [p, { oid }]));
}

function parked(p: Record<string, ParkedReview>): Map<string, ParkedReview> {
  return new Map(Object.entries(p));
}

describe('planGitOperation — taking pending content off disk', () => {
  it('parks it, against the baseline it was pending against', () => {
    const plan = planGitOperation(snapshot({ a: 'H' }, { a: 'B' }), observed({ a: 'A' }), parked({}));
    expect(plan.accept).toEqual(['a']);
    expect(plan.park).toEqual([{ relPath: 'a', pending: 'A', restore: entry('B') }]);
    expect(plan.restore).toEqual([]);
  });

  it('parks a pending deletion and a created file that was never in the baseline', () => {
    const plan = planGitOperation(
      snapshot({ gone: 'G', created: null }, { gone: 'G' }),
      observed({ gone: null, created: 'N' }),
      parked({}),
    );
    expect(plan.park).toEqual([
      { relPath: 'gone', pending: null, restore: entry('G') },
      { relPath: 'created', pending: 'N', restore: null },
    ]);
  });

  it('parks nothing for a path nobody had pending — a plain pull stays a plain accept', () => {
    const plan = planGitOperation(snapshot({ a: 'H' }, { a: 'B' }), observed({}), parked({}));
    expect(plan).toEqual({ restore: [], accept: ['a'], park: [], drop: [] });
  });

  it('parks nothing when the content seen pending was accepted since', () => {
    const plan = planGitOperation(snapshot({ a: 'H' }, { a: 'A' }), observed({ a: 'A' }), parked({}));
    expect(plan.park).toEqual([]);
  });

  it('parks nothing when the operation left that content on disk', () => {
    const plan = planGitOperation(snapshot({ a: 'A' }, { a: 'B' }), observed({ a: 'A' }), parked({}));
    expect(plan.park).toEqual([]);
  });

  it('never plans on a file it could not hash', () => {
    const plan = planGitOperation(
      snapshot({ a: undefined }, { a: 'H' }),
      observed({ a: 'A' }),
      parked({ a: { pending: 'A', restore: entry('B'), accepted: 'H' } }),
    );
    expect(plan).toEqual({ restore: [], accept: ['a'], park: [], drop: [] });
  });
});

describe('planGitOperation — content coming back', () => {
  const stashed = { a: { pending: 'A', restore: entry('B'), accepted: 'H' } };

  it('restores the old baseline instead of accepting', () => {
    const plan = planGitOperation(snapshot({ a: 'A' }, { a: 'H' }), observed({}), parked(stashed));
    expect(plan.restore).toEqual([{ relPath: 'a', entry: entry('B') }]);
    expect(plan.accept).toEqual([]);
  });

  it('restores a deletion and a created file too', () => {
    const plan = planGitOperation(
      snapshot({ gone: null, created: 'N' }, { gone: 'G' }),
      observed({}),
      parked({
        gone: { pending: null, restore: entry('G'), accepted: 'G' },
        created: { pending: 'N', restore: null, accepted: null },
      }),
    );
    expect(plan.restore).toEqual([
      { relPath: 'gone', entry: entry('G') },
      { relPath: 'created', entry: null },
    ]);
  });

  it('does not restore once the baseline has moved on from what the stash left', () => {
    const plan = planGitOperation(snapshot({ a: 'A' }, { a: 'U' }), observed({}), parked(stashed));
    expect(plan.restore).toEqual([]);
    expect(plan.accept).toEqual(['a']);
  });

  it('accepts different content — a pull, or a pop that merged — and drops the void entry', () => {
    const plan = planGitOperation(snapshot({ a: 'H2' }, { a: 'H' }), observed({}), parked(stashed));
    expect(plan.restore).toEqual([]);
    expect(plan.accept).toEqual(['a']);
    expect(plan.drop).toEqual(['a']);
  });

  it('keeps the entry when the operation rewrites the content the stash left', () => {
    const plan = planGitOperation(snapshot({ a: 'H' }, { a: 'H' }), observed({}), parked(stashed));
    expect(plan.drop).toEqual([]);
  });
});
