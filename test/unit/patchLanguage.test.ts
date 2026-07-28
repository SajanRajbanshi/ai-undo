import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { aliasLanguageIds, patchLanguageFor } from '../../src/ui/patchLanguage';

const root = path.resolve(__dirname, '../..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  contributes: {
    languages?: { id: string; extensions?: string[]; filenames?: string[] }[];
    grammars?: { language: string; scopeName: string; path: string }[];
  };
};

describe('patchLanguageFor', () => {
  it('redirects the languages whose validators do not filter by scheme', () => {
    expect(patchLanguageFor('json')).toBe('lfct-json');
    expect(patchLanguageFor('css')).toBe('lfct-css');
  });

  /**
   * TypeScript limits its features to `file` and `untitled`, so a patch
   * document is never analysed and the real language is the better choice —
   * same grammar, and no extra language to maintain.
   */
  it('leaves languages that are already scheme-gated alone', () => {
    expect(patchLanguageFor('typescript')).toBeUndefined();
    expect(patchLanguageFor('javascript')).toBeUndefined();
    expect(patchLanguageFor('python')).toBeUndefined();
  });

  it('never redirects an alias to itself', () => {
    for (const id of aliasLanguageIds()) {
      expect(patchLanguageFor(id)).toBeUndefined();
    }
  });
});

/**
 * The alias only works if the code and the manifest agree. A missing
 * declaration means VS Code silently falls back to plain text — highlighting
 * quietly gone, with nothing to notice at runtime.
 */
describe('the manifest declares every alias', () => {
  const languages = manifest.contributes.languages ?? [];
  const grammars = manifest.contributes.grammars ?? [];

  it.each(aliasLanguageIds())('declares %s as a language', (id) => {
    expect(languages.map((l) => l.id)).toContain(id);
  });

  it.each(aliasLanguageIds())('declares a grammar for %s', (id) => {
    const grammar = grammars.find((g) => g.language === id);
    expect(grammar).toBeDefined();
    expect(fs.existsSync(path.join(root, grammar!.path))).toBe(true);
  });

  /**
   * These must never be resolved from a filename — they exist solely to be set
   * explicitly on a patch document. An `extensions` entry would hijack the
   * user's real files.
   */
  it('claims no file extensions or filenames', () => {
    for (const id of aliasLanguageIds()) {
      const language = languages.find((l) => l.id === id)!;
      expect(language.extensions ?? []).toEqual([]);
      expect(language.filenames ?? []).toEqual([]);
    }
  });

  it('delegates to a real grammar rather than defining its own rules', () => {
    for (const id of aliasLanguageIds()) {
      const grammar = grammars.find((g) => g.language === id)!;
      const contents = JSON.parse(fs.readFileSync(path.join(root, grammar.path), 'utf8')) as {
        scopeName: string;
        patterns: { include: string }[];
      };
      expect(contents.scopeName).toBe(grammar.scopeName);
      // Exactly one include and nothing else: identical highlighting to the
      // original, with no rules of ours to drift out of date.
      expect(contents.patterns).toHaveLength(1);
      expect(contents.patterns[0].include).toMatch(/^(source|text)\./);
      expect(contents.patterns[0].include).not.toContain('lfct');
    }
  });
});
