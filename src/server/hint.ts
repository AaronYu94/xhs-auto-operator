/**
 * 「?」: a page states the conclusion and keeps the explanation one click away.
 *
 * The console used to explain itself in paragraphs — footnotes under tables, help text under every field, the same
 * sentence repeated on three tabs. A salesperson reads the numbers, not the manual. The implementation lives in
 * `render.ts` (so `sectionHead` can use it without a circular import); this module is the import pages use.
 */
export { hint } from './render.ts';
