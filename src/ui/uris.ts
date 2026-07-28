import * as vscode from 'vscode';

import type { FileStatusCode } from '../store/CheckpointStore';

/**
 * §7.5 / §7.5.1 — the two virtual document schemes.
 *
 *   lfct:/src/app.ts?ref=HEAD          baseline content (diff left-hand side)
 *   lfct-patch:/src/app.ts.diff?...    unified patch (the inline review surface)
 *
 * Neither scheme has a FileSystemProvider, which is what makes both read-only
 * without any extra plumbing.
 */

export const BASELINE_SCHEME = 'lfct';
export const PATCH_SCHEME = 'lfct-patch';

export function baselineUri(relPath: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: BASELINE_SCHEME,
    path: '/' + relPath,
    // `ref` is fixed at HEAD in v1. It is in the URI already so that per-commit
    // history (N4, §16) becomes addressable without changing the scheme.
    query: 'ref=HEAD',
  });
}

export function patchUri(relPath: string, status: FileStatusCode): vscode.Uri {
  return vscode.Uri.from({
    scheme: PATCH_SCHEME,
    // Keeps the file's own extension, which is what makes VS Code apply the
    // file's own grammar — `app.ts` is highlighted as TypeScript. It used to
    // carry a `.diff` suffix to select the diff grammar instead, but that
    // grammar only colors `+`/`-` lines and renders the code itself as plain
    // text. `formatPatchForDisplay` strips the prefixes so the lines really are
    // source, and `PatchDecorator` draws the change kind as a background.
    //
    // Safe because language *servers* are scheme-gated — TypeScript's
    // `getSemanticSupportedSchemes()` covers `file` and `untitled`, not this —
    // so the grammar highlights while nothing tries to type-check a document
    // that interleaves two versions of a file.
    path: '/' + relPath,
    query: `status=${status}`,
  });
}

/**
 * Right-hand side for a deleted file's side-by-side diff. The file no longer
 * exists on disk, so `vscode.diff` needs something to point at.
 */
export function emptyUri(relPath: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: BASELINE_SCHEME,
    path: '/' + relPath,
    query: 'ref=EMPTY',
  });
}

/** Inverse of `baselineUri`. */
export function relPathFromBaselineUri(uri: vscode.Uri): string {
  return uri.path.replace(/^\//, '');
}

/** Inverse of `patchUri`. */
export function relPathFromPatchUri(uri: vscode.Uri): string {
  return uri.path.replace(/^\//, '');
}

export function statusFromPatchUri(uri: vscode.Uri): FileStatusCode {
  const match = /(?:^|&)status=([MAD])(?:&|$)/.exec(uri.query);
  return (match?.[1] as FileStatusCode) ?? 'M';
}
