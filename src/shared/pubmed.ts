/**
 * PubMed search subscriptions: the query builder, its query text, and the
 * PubMed addresses FeedLantern recognises. Shared by the server (validation,
 * fetching), the interface (the builder) and the CLI.
 *
 * A PubMed search feed stores only its query and how many of the newest
 * articles to read, as the PubMed search page that shows the same results:
 * `https://pubmed.ncbi.nlm.nih.gov/?term=<query>&sort=date&size=<limit>`.
 * The builder state is never stored: it is parsed back from the query.
 */

/** Fields of the builder, in menu order. `tag` is the PubMed field tag the builder writes. */
export const PUBMED_FIELDS = {
  all: { tag: 'All Fields', aliases: ['all', 'all fields', 'tw', 'text word', 'text'] },
  tiab: { tag: 'Title/Abstract', aliases: ['tiab', 'title/abstract'] },
  title: { tag: 'Title', aliases: ['ti', 'title'] },
  author: { tag: 'Author', aliases: ['au', 'author', 'auth', 'full author name', 'fau'] },
  firstAuthor: { tag: 'Author - First', aliases: ['1au', 'author - first', 'first author'] },
  lastAuthor: { tag: 'Author - Last', aliases: ['lastau', 'author - last', 'last author'] },
  journal: { tag: 'Journal', aliases: ['ta', 'jour', 'journal', 'jo'] },
  affiliation: { tag: 'Affiliation', aliases: ['ad', 'affiliation', 'affl'] },
  mesh: { tag: 'MeSH Terms', aliases: ['mh', 'mesh terms', 'mesh'] },
  pubType: { tag: 'Publication Type', aliases: ['pt', 'publication type'] },
  language: { tag: 'Language', aliases: ['la', 'lang', 'language'] },
  /** The journal's NLM Unique ID; PubMed maps it to the journal (101238921[jid] → "plos pathog"[Journal]). */
  nlmId: { tag: 'jid', aliases: ['jid'] },
} as const;
export type PubmedField = keyof typeof PUBMED_FIELDS;
export const PUBMED_FIELD_IDS = Object.keys(PUBMED_FIELDS) as PubmedField[];

export type PubmedOperator = 'AND' | 'OR' | 'NOT';
export const PUBMED_OPERATORS: readonly PubmedOperator[] = ['AND', 'OR', 'NOT'];
/**
 * One builder line. The first line's `op` is not used. `phrase` puts the term
 * in quotes, which turns off PubMed's automatic term mapping (MeSH, synonyms,
 * author name variants) and matches the exact phrase only.
 */
export interface PubmedRow { op: PubmedOperator; field: PubmedField; term: string; phrase?: boolean }

/** Article-type shortcuts, written as `"<name>"[pt]` and OR-ed together. */
export const PUBMED_ARTICLE_TYPES = ['Review', 'Systematic Review', 'Meta-Analysis', 'Clinical Trial', 'Randomized Controlled Trial', 'Case Reports'] as const;
export type PubmedArticleType = typeof PUBMED_ARTICLE_TYPES[number];

export interface PubmedFilters {
  /** Published in the last N days (`"last N days"[Date - Publication]`). */
  days?: number;
  /** Publication date range, `YYYY`, `YYYY/MM` or `YYYY/MM/DD`; either end may be open. */
  from?: string;
  to?: string;
  /** Only records with an abstract (`hasabstract`). */
  hasAbstract?: boolean;
  types?: PubmedArticleType[];
}
export interface PubmedBuilder { rows: PubmedRow[]; filters: PubmedFilters }

export const PUBMED_QUERY_MAX = 4000;
export const PUBMED_DAYS_MAX = 36_500;
/** How many of the newest articles each fetch reads; PubMed's own page sizes. */
export const PUBMED_LIMITS = [10, 20, 50, 100] as const;
export const PUBMED_DEFAULT_LIMIT = 20;
export interface PubmedSearch { query: string; limit: number }

const DATE_TAGS = ['date - publication', 'dp', 'pdat', 'publication date'];
const OPEN_FROM = '1800', OPEN_TO = '3000';
const DATE_PART = /^\d{4}(?:\/(?:0?[1-9]|1[0-2])(?:\/(?:0?[1-9]|[12]\d|3[01]))?)?$/;
export const isPubmedDate = (value: string) => DATE_PART.test(value);

// Writing a query

/** Drops the parentheses that have no partner, keeping balanced groups as the user wrote them. */
function balanceParentheses(text: string): string {
  const drop = new Set<number>(), open: number[] = [];
  let quoted = false;
  [...text].forEach((char, index) => {
    if (char === '"') quoted = !quoted;
    else if (quoted) return;
    else if (char === '(') open.push(index);
    else if (char === ')') { if (open.length) open.pop(); else drop.add(index); }
  });
  for (const index of open) drop.add(index);
  return [...text].filter((_, index) => !drop.has(index)).join('');
}

/**
 * The term as one query leaf, written as PubMed's Advanced Search Builder
 * writes it: `term[Field]`, unquoted and unchanged, so PubMed maps it to MeSH
 * terms, synonyms and author name variants (automatic term mapping); All
 * Fields has no tag. Only what would break the query is changed: `[` and `]`
 * (they would start a field tag) become spaces, and an unpaired parenthesis
 * or double quote is dropped. A term the user put in quotes stays quoted;
 * `phrase` adds the quotes (an exact phrase, without term mapping).
 */
export function pubmedTerm(field: PubmedField, raw: string, phrase = false): string {
  let text = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (/^".+"$/s.test(text) && (text.match(/"/g) ?? []).length === 2) { phrase = true; text = text.slice(1, -1); }
  // PubMed has no escape for a double quote inside a phrase.
  if (phrase || (text.match(/"/g) ?? []).length % 2) text = text.replace(/"/g, ' ');
  text = text.replace(/[[\]]/g, ' ');
  if (!phrase) text = balanceParentheses(text);
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const tag = field === 'all' ? '' : `[${PUBMED_FIELDS[field].tag}]`;
  if (phrase) return `"${text}"${tag}`;
  // An operator with nothing on one side (a term that is just "OR", or starts with "AND ") would break the
  // query; only then are the operator words lower-cased, which PubMed reads as ordinary words.
  if (pubmedQueryProblem(`(${text}${tag})`)) text = text.replace(/\b(AND|OR|NOT)\b/g, word => word.toLowerCase());
  return `${text}${tag}`;
}

/** Upper-case AND, OR or NOT inside an unquoted term: PubMed reads them as operators. */
export const pubmedTermHasOperator = (term: string, phrase = false) => !phrase && !/^".+"$/s.test(term.trim()) && /(?:^|[\s(])(?:AND|OR|NOT)(?=[\s)]|$)/.test(term);

function dateFilter(filters: PubmedFilters): string {
  if (filters.days) return `"last ${filters.days} days"[Date - Publication]`;
  const from = filters.from?.trim(), to = filters.to?.trim();
  if (!from && !to) return '';
  return `${from || OPEN_FROM}:${to || OPEN_TO}[Date - Publication]`;
}

/** The query the builder stands for: rows left to right as PubMed's Advanced Search Builder nests them, then the filters. */
export function buildPubmedQuery(builder: PubmedBuilder): string {
  const leaves = builder.rows.map(row => ({ op: row.op, leaf: pubmedTerm(row.field, row.term, row.phrase) })).filter(row => row.leaf);
  let body = '';
  leaves.forEach((row, index) => {
    if (index === 0) body = `(${row.leaf})`;
    else body = `${index === 1 ? body : `(${body})`} ${row.op} (${row.leaf})`;
  });
  const { filters } = builder;
  const types = [...new Set(filters.types ?? [])].filter(type => PUBMED_ARTICLE_TYPES.includes(type));
  const extra = [dateFilter(filters), filters.hasAbstract ? 'hasabstract' : '', types.map(type => `"${type}"[pt]`).join(' OR ')].filter(Boolean);
  if (!extra.length) return body;
  return [leaves.length > 1 ? `(${body})` : body, ...extra.map(part => `(${part})`)].filter(Boolean).join(' AND ');
}

// Reading a query

type Token = { kind: '(' | ')' } | { kind: 'op'; op: PubmedOperator } | { kind: 'leaf'; text: string; quoted: boolean; tag?: string };
export type PubmedQueryProblem = 'empty' | 'tooLong' | 'unbalancedQuotes' | 'unbalancedParentheses' | 'unclosedTag' | 'danglingOperator' | 'emptyGroup';

/** Splits a query into parentheses, upper-case operators and leaves; adjacent bare words form one leaf, as in PubMed. */
function tokenize(query: string): Token[] | PubmedQueryProblem {
  const tokens: Token[] = [];
  let i = 0;
  const tag = (): string | undefined | PubmedQueryProblem => {
    if (query[i] !== '[') return undefined;
    const end = query.indexOf(']', i);
    if (end < 0) return 'unclosedTag';
    const value = query.slice(i + 1, end).trim();
    i = end + 1;
    return value;
  };
  while (i < query.length) {
    const char = query[i];
    if (/\s/.test(char)) { i++; continue; }
    if (char === '(' || char === ')') { tokens.push({ kind: char }); i++; continue; }
    if (char === '"') {
      const end = query.indexOf('"', i + 1);
      if (end < 0) return 'unbalancedQuotes';
      const text = query.slice(i + 1, end).replace(/\s+/g, ' ').trim();
      i = end + 1;
      const found = tag();
      if (found === 'unclosedTag') return found;
      tokens.push({ kind: 'leaf', text, quoted: true, ...(found !== undefined ? { tag: found } : {}) });
      continue;
    }
    if (char === '[') {
      // A tag after a space ("x" [tiab]) still belongs to the term before it.
      const found = tag();
      if (found === 'unclosedTag') return found;
      const previous = tokens.at(-1);
      if (previous?.kind === 'leaf' && previous.tag === undefined && found !== undefined) previous.tag = found;
      continue;
    }
    let end = i;
    while (end < query.length && !/[\s()"[]/.test(query[end])) end++;
    const word = query.slice(i, end);
    i = end;
    if (word === 'AND' || word === 'OR' || word === 'NOT') { tokens.push({ kind: 'op', op: word }); continue; }
    const found = tag();
    if (found === 'unclosedTag') return found;
    const previous = tokens.at(-1);
    // "heart attack[tiab]" is one phrase, as PubMed's own builder writes it.
    if (previous?.kind === 'leaf' && !previous.quoted && previous.tag === undefined) { previous.text += ` ${word}`; if (found !== undefined) previous.tag = found; }
    else tokens.push({ kind: 'leaf', text: word, quoted: false, ...(found !== undefined ? { tag: found } : {}) });
  }
  return tokens;
}

type Leaf = Extract<Token, { kind: 'leaf' }> & { type: 'leaf' };
type Group = { type: 'group'; first: Node; rest: Array<{ op: PubmedOperator; node: Node }> };
type Node = Leaf | Group;

function parseTree(tokens: Token[]): Node | PubmedQueryProblem {
  let i = 0;
  const expression = (depth: number): Node | PubmedQueryProblem => {
    const first = operand(depth);
    if (typeof first === 'string') return first;
    const rest: Group['rest'] = [];
    while (i < tokens.length) {
      const token = tokens[i];
      if (token.kind === ')') { if (!depth) return 'unbalancedParentheses'; break; }
      let op: PubmedOperator = 'AND';
      // Adjacent terms are AND-ed, as PubMed does.
      if (token.kind === 'op') { op = token.op; i++; }
      if (i >= tokens.length) return 'danglingOperator';
      const node = operand(depth);
      if (typeof node === 'string') return node;
      rest.push({ op, node });
    }
    return rest.length ? { type: 'group', first, rest } : first;
  };
  const operand = (depth: number): Node | PubmedQueryProblem => {
    const token = tokens[i];
    if (!token) return 'danglingOperator';
    if (token.kind === 'op' || token.kind === ')') return 'danglingOperator';
    i++;
    if (token.kind === 'leaf') return { ...token, type: 'leaf' };
    if (tokens[i]?.kind === ')') return 'emptyGroup';
    const inner = expression(depth + 1);
    if (typeof inner === 'string') return inner;
    if (tokens[i]?.kind !== ')') return 'unbalancedParentheses';
    i++;
    // A group of one element is just that element.
    return inner;
  };
  const tree = expression(0);
  if (typeof tree === 'string') return tree;
  return i < tokens.length ? 'unbalancedParentheses' : tree;
}

/** Why a query cannot be sent, or null. Lenient: PubMed itself accepts far more than the builder writes. */
export function pubmedQueryProblem(query: string): PubmedQueryProblem | null {
  const text = query.trim();
  if (!text) return 'empty';
  if (text.length > PUBMED_QUERY_MAX) return 'tooLong';
  const tokens = tokenize(text);
  if (typeof tokens === 'string') return tokens;
  if (!tokens.length) return 'empty';
  const tree = parseTree(tokens);
  return typeof tree === 'string' ? tree : null;
}

const fieldOf = (tag: string | undefined): PubmedField | undefined => {
  if (tag === undefined) return 'all';
  const name = tag.toLowerCase().replace(/\s+/g, ' ').trim();
  return PUBMED_FIELD_IDS.find(id => (PUBMED_FIELDS[id].aliases as readonly string[]).includes(name) || PUBMED_FIELDS[id].tag.toLowerCase() === name);
};
const articleType = (leaf: Node): PubmedArticleType | undefined => leaf.type === 'leaf' && leaf.tag?.toLowerCase() === 'pt' ? PUBMED_ARTICLE_TYPES.find(type => type.toLowerCase() === leaf.text.toLowerCase()) : undefined;

/** A trailing AND-ed part the builder writes as a filter, read into `filters`. */
function readFilter(node: Node, filters: PubmedFilters): boolean {
  if (node.type === 'leaf' && node.tag && DATE_TAGS.includes(node.tag.toLowerCase()) && filters.days === undefined && filters.from === undefined && filters.to === undefined) {
    const relative = /^last (\d{1,5}) days?$/i.exec(node.text);
    if (relative && Number(relative[1]) >= 1 && Number(relative[1]) <= PUBMED_DAYS_MAX) { filters.days = Number(relative[1]); return true; }
    const range = /^([\d/]+):([\d/]+)$/.exec(node.text.replace(/\s+/g, ''));
    if (range && isPubmedDate(range[1]) && isPubmedDate(range[2])) {
      if (range[1] !== OPEN_FROM) filters.from = range[1];
      if (range[2] !== OPEN_TO) filters.to = range[2];
      if (filters.from === undefined && filters.to === undefined) return false;
      return true;
    }
    return false;
  }
  if (node.type === 'leaf' && node.text.toLowerCase() === 'hasabstract' && !filters.hasAbstract && (node.tag === undefined || ['all fields', 'text', 'text word', 'tw', 'sb', 'filter'].includes(node.tag.toLowerCase()))) { filters.hasAbstract = true; return true; }
  if (filters.types) return false;
  const parts = node.type === 'leaf' ? [node] : node.rest.every(entry => entry.op === 'OR') ? [node.first, ...node.rest.map(entry => entry.node)] : [];
  const types = parts.map(articleType);
  if (!types.length || types.some(type => !type)) return false;
  filters.types = [...new Set(types as PubmedArticleType[])];
  return true;
}

function readRows(node: Node, op: PubmedOperator | null, rows: PubmedRow[]): boolean {
  if (node.type === 'leaf') {
    const field = fieldOf(node.tag);
    if (!field || !node.text) return false;
    rows.push({ op: op ?? 'AND', field, term: node.text, ...(node.quoted ? { phrase: true } : {}) });
    return true;
  }
  // A group on the left can always be spread out (PubMed reads left to right);
  // elsewhere only when it repeats the operator it is joined with.
  if (op !== null && (op === 'NOT' || node.rest.some(entry => entry.op !== op))) return false;
  if (!readRows(node.first, op, rows)) return false;
  return node.rest.every(entry => readRows(entry.node, entry.op, rows));
}

/** The builder lines and filters a query stands for, or null when the builder cannot show it (then it is edited by hand). */
export function parsePubmedQuery(query: string): PubmedBuilder | null {
  if (pubmedQueryProblem(query)) return null;
  const tokens = tokenize(query.trim()) as Token[];
  const tree = parseTree(tokens) as Node;
  const items: Array<{ op: PubmedOperator | null; node: Node }> = tree.type === 'group' ? [{ op: null, node: tree.first }, ...tree.rest] : [{ op: null, node: tree }];
  const filters: PubmedFilters = {};
  while (items.length) {
    const last = items.at(-1)!;
    if (last.op === 'OR' || last.op === 'NOT') break;
    if (!readFilter(last.node, filters)) break;
    items.pop();
  }
  const rows: PubmedRow[] = [];
  for (const item of items) if (!readRows(item.node, item.op, rows)) return null;
  if (rows.length) rows[0] = { ...rows[0], op: 'AND' };
  return { rows, filters };
}

// Addresses

const PUBMED_HOST = 'pubmed.ncbi.nlm.nih.gov';
const pubmedUrl = (raw: string): URL | null => {
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) && url.hostname.toLowerCase() === PUBMED_HOST && !url.username && !url.password ? url : null;
  } catch { return null; }
};
export const nearestPubmedLimit = (value: number) => PUBMED_LIMITS.find(limit => limit >= value) ?? PUBMED_LIMITS.at(-1)!;

/** The PubMed search page listing the same newest articles (also the address the feed stores). */
export function pubmedSearchUrl(search: PubmedSearch): string {
  return `https://${PUBMED_HOST}/?${new URLSearchParams({ term: search.query.trim(), sort: 'date', size: String(search.limit) })}`;
}

/** The search a stored PubMed search address holds, or null for any other address. */
export function pubmedSearchFromUrl(raw: string): PubmedSearch | null {
  const url = pubmedUrl(raw);
  if (!url || url.pathname !== '/') return null;
  const query = url.searchParams.get('term')?.trim();
  if (!query) return null;
  const size = Number(url.searchParams.get('size'));
  return { query, limit: (PUBMED_LIMITS as readonly number[]).includes(size) ? size : PUBMED_DEFAULT_LIMIT };
}

/**
 * A PubMed RSS address: a journal feed (`/rss/journals/<NLM ID>/`, blocked by
 * NCBI's bot check since 2026) or a saved-search feed (`/rss/search/<id>/`,
 * whose id cannot be turned back into the search).
 */
export type PubmedRss = { kind: 'journal'; nlmId: string; name?: string; limit: number } | { kind: 'search'; id: string; name?: string; limit: number };
export function pubmedRssSource(raw: string): PubmedRss | null {
  const url = pubmedUrl(raw);
  if (!url) return null;
  const requested = Number(url.searchParams.get('limit'));
  const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 100) : 15;
  const name = url.searchParams.get('name')?.replace(/\s+/g, ' ').trim().slice(0, 200) || undefined;
  // NLM IDs are digits; some older ones end in a letter (for example 0372516R).
  const journal = /^\/rss\/journals\/(\d{4,10}[A-Za-z]?)\/?$/.exec(url.pathname);
  if (journal) return { kind: 'journal', nlmId: journal[1].toUpperCase(), limit, ...(name ? { name } : {}) };
  const search = /^\/rss\/search\/([A-Za-z0-9_-]{1,100})\/?$/.exec(url.pathname);
  return search ? { kind: 'search', id: search[1], limit, ...(name ? { name } : {}) } : null;
}

/**
 * What converting a PubMed RSS subscription prefills: a journal feed becomes a
 * Journal condition (the address's `name` is the journal's abbreviation, the
 * value PubMed's Journal field matches), else the NLM ID; a saved search starts empty.
 */
export function pubmedConversion(rss: PubmedRss): { builder: PubmedBuilder; limit: number } {
  const limit = nearestPubmedLimit(rss.limit);
  if (rss.kind === 'search') return { builder: { rows: [{ op: 'AND', field: 'all', term: '' }], filters: {} }, limit };
  return { builder: { rows: [rss.name ? { op: 'AND', field: 'journal', term: rss.name } : { op: 'AND', field: 'nlmId', term: rss.nlmId }], filters: {} }, limit };
}

/** Longest feed name (the API's limit). */
export const FEED_NAME_MAX = 200;
/** The fixed suffix of a PubMed search's default name; not translated. */
export const PUBMED_NAME_SUFFIX = ' - PubMed';

/**
 * A PubMed search's default name: the query exactly as it is sent, then
 * " - PubMed" (as PubMed titles its own search pages). A query too long for
 * a name keeps its beginning and end with an ellipsis in the middle; the feed
 * still stores and runs the full query.
 */
export function pubmedDefaultName(query: string): string {
  const text = query.replace(/\s+/g, ' ').trim();
  const room = FEED_NAME_MAX - PUBMED_NAME_SUFFIX.length;
  if (text.length <= room) return `${text}${PUBMED_NAME_SUFFIX}`;
  const head = Math.ceil((room - 1) / 2), tail = room - 1 - head;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}${PUBMED_NAME_SUFFIX}`;
}

// Converting a PubMed search RSS feed

/**
 * A search RSS feed's channel title is the search itself, for example
 * `((Shandong University[Affiliation]) OR …) AND (Sun Jin-peng[Author])`.
 * The query read from it: suffixes PubMed adds are removed; a title that ends
 * in an ellipsis, an operator or an open quote is marked `truncated`;
 * unbalanced parentheses are closed (`repaired`). Neither is trusted on its
 * own: the conversion check compares the query's results with the feed's items.
 */
export interface RssTitleQuery { query: string; repaired: boolean; truncated: boolean }
export function pubmedQueryFromRssTitle(title: string): RssTitleQuery {
  let text = title.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/\s*[:：]\s*Latest results from PubMed\.?$/i, '').replace(/^pubmed\s*[:：]\s*/i, '').trim();
  let truncated = false;
  if (/(?:\.\.\.|…)$/.test(text)) { truncated = true; text = text.replace(/\s*(?:\.\.\.|…)$/, '').trim(); }
  if (/(?:^|\s)(?:AND|OR|NOT)$/.test(text)) truncated = true;
  let open = 0, close = 0, quoted = false;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === '(') open++;
    else if (!quoted && char === ')') close++;
  }
  if (quoted) truncated = true;
  let repaired = false;
  if (!truncated && open !== close) {
    text = open > close ? text + ')'.repeat(open - close) : '('.repeat(close - open) + text;
    repaired = true;
  }
  return { query: text, repaired, truncated };
}

/** How the conversion check compares a feed with its query: the newest `sample` items against the newest `window` matches. */
export const PUBMED_COVERAGE = { sample: 20, window: 200, threshold: 0.8 } as const;

/** The PMID of a PubMed article link (`https://pubmed.ncbi.nlm.nih.gov/<PMID>/…`), or null. */
export function pubmedPmidOf(link: string): string | null {
  const url = pubmedUrl(link);
  return url ? /^\/(\d{1,10})\/?$/.exec(url.pathname)?.[1] ?? null : null;
}

/** How many of the expected PMIDs (newest first, at most `sample`) are among the found ones. */
export function pubmedCoverage(expected: readonly string[], found: readonly string[]): { matched: number; total: number; ratio: number } {
  const sample = [...new Set(expected)].slice(0, PUBMED_COVERAGE.sample);
  const pool = new Set(found);
  const matched = sample.filter(id => pool.has(id)).length;
  return { matched, total: sample.length, ratio: sample.length ? matched / sample.length : 0 };
}
