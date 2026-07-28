/**
 * Language selection for the unified patch view (§7.5.1 surface 1).
 *
 * The patch is rendered as real source so the file's own grammar highlights it.
 * The cost is that the document *interleaves two versions of the same file*, so
 * anything that analyses it semantically sees nonsense — two `"default"` keys in
 * one JSON object, a symbol declared twice — and reports errors that describe
 * the rendering, not the user's code.
 *
 * Whether that happens is decided per language extension, and they do not agree:
 *
 *  - **TypeScript and JavaScript are safe.** `getSemanticSupportedSchemes()`
 *    limits their features to `file`, `untitled` and a few internal schemes, so
 *    a `lfct-patch:` document is never analysed.
 *  - **JSON, HTML and the CSS family are not.** Those ship in-process
 *    validators whose document selector is language-only, with no scheme
 *    filter, so they validate whatever they are given.
 *  - **Most third-party servers** need a real file on disk and so behave like
 *    the first group.
 *
 * There is no API to opt a document out of another extension's diagnostics, so
 * for the second group the patch is given a language of our own — declared in
 * `contributes.languages`, with a grammar that does nothing but `include` the
 * original scope. Identical highlighting, and no server is registered for it,
 * so nothing has an opinion about the content.
 *
 * Adding a language here is a three-line change: an entry below, an entry in
 * `contributes.languages`, and a one-line grammar in `syntaxes/`.
 */
const ALIASES: Readonly<Record<string, string>> = {
  json: 'lfct-json',
  jsonc: 'lfct-jsonc',
  html: 'lfct-html',
  css: 'lfct-css',
  scss: 'lfct-scss',
  less: 'lfct-less',
};

/**
 * The language a patch document should use, or `undefined` to keep the one VS
 * Code resolved from the file extension.
 */
export function patchLanguageFor(languageId: string): string | undefined {
  return ALIASES[languageId];
}

/** The alias language ids, for asserting the manifest declares each one. */
export function aliasLanguageIds(): string[] {
  return Object.values(ALIASES);
}
