/**
 * PubMed journal RSS addresses (https://pubmed.ncbi.nlm.nih.gov/rss/journals/<NLM ID>/)
 * are fetched through NCBI E-utilities instead of the address itself. The
 * server and the interface share this check so the panel can say how a
 * source is really fetched.
 */
export const PUBMED_JOURNAL_LIMIT = { default: 15, max: 100 } as const;

export interface PubmedJournalSource {
  /** The journal's NLM Unique ID, for example 101238921 (PLoS Pathog). */
  nlmId: string;
  /** How many of the newest articles to read: the address's `limit`, 15 by default, at most 100. */
  limit: number;
  /** The `name` parameter PubMed adds to the address, used as the feed title. */
  name?: string;
}

/** The journal a PubMed journal RSS address points to, or null for any other address. */
export function pubmedJournalSource(raw: string): PubmedJournalSource | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.hostname.toLowerCase() !== 'pubmed.ncbi.nlm.nih.gov' || url.username || url.password) return null;
  // NLM IDs are digits, some older ones end in a letter (for example 0372516R).
  const match = /^\/rss\/journals\/(\d{4,10}[A-Za-z]?)\/?$/.exec(url.pathname);
  if (!match) return null;
  const requested = Number(url.searchParams.get('limit'));
  const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, PUBMED_JOURNAL_LIMIT.max) : PUBMED_JOURNAL_LIMIT.default;
  const name = url.searchParams.get('name')?.trim().slice(0, 200);
  return { nlmId: match[1].toUpperCase(), limit, ...(name ? { name } : {}) };
}
