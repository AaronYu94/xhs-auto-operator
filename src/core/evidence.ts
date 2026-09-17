import { normalizeText } from './text.ts';
import type { Evidence } from './types.ts';

type Sources = string | readonly (string | null | undefined)[];

const toList = (sources: Sources): string[] =>
  (typeof sources === 'string' ? [sources] : sources).filter((s): s is string => typeof s === 'string' && s.length > 0);

/** True when `quote` occurs verbatim (NFKC + case-insensitive) in at least one source text. */
export function isVerbatimQuote(sources: Sources, quote: string | undefined | null): boolean {
  if (!quote) return false;
  const q = normalizeText(quote);
  if (!q) return false;
  return toList(sources).some((s) => normalizeText(s).includes(q));
}

/**
 * Anti-hallucination guard for evidence: keeps only evidence whose quote is a verbatim substring of
 * the analyzed source text(s). Evidence without a quote is dropped unless `allowUnquoted`.
 */
export function keepVerbatimEvidence(
  sources: Sources,
  evidence: readonly Evidence[],
  opts: { allowUnquoted?: boolean } = {},
): Evidence[] {
  return evidence.filter((e) => (e.quote ? isVerbatimQuote(sources, e.quote) : opts.allowUnquoted === true));
}

/** Deduplicate evidence by (code, normalized quote); first occurrence wins. */
export function dedupeEvidence(evidence: readonly Evidence[]): Evidence[] {
  const seen = new Set<string>();
  const out: Evidence[] = [];
  for (const e of evidence) {
    const key = `${e.code}::${e.quote ? normalizeText(e.quote) : ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}
