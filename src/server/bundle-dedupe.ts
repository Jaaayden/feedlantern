import type { BundleDedupe, BundleMergeReason } from '../shared/types.js';
import { normalizeLink } from './links.js';

/**
 * Deciding which items of a bundle are the same item. The rules only exist
 * for bundles: `normalizeLink` stays as it is, because the identity of the
 * items stored inside one feed depends on it.
 */

/** Query parameters that say where a visitor came from, not which page it is. */
const TRACKING_PARAMETER = /^(utm_.*|hsa_.*|fbclid|gclid|dclid|gbraid|wbraid|msclkid|yclid|twclid|igshid|mc_cid|mc_eid|_hsenc|_hsmi|spm|scm|ref|ref_src|ref_url|share_source|cmpid|ocid)$/i;
const TITLE_LIMIT = 500;
const DAY_MS = 86_400_000;

/**
 * The link without what does not change the page: tracking parameters, the
 * scheme (`http` = `https`), a `www.` prefix, trailing slashes, the fragment
 * and the order of the remaining parameters.
 */
export function dedupeUrlKey(link: string): string {
  try {
    const url = new URL(link.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return normalizeLink(link);
    const parameters = [...url.searchParams].filter(([name]) => !TRACKING_PARAMETER.test(name))
      .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0));
    const query = new URLSearchParams(parameters).toString();
    return `${url.hostname.toLowerCase().replace(/^www\./, '')}${url.port ? `:${url.port}` : ''}${url.pathname.replace(/\/+$/, '')}${query ? `?${query}` : ''}`;
  } catch {
    return normalizeLink(link);
  }
}

/** Case, full-width forms, extra spaces and punctuation do not make a different title. Null when nothing is left to compare. */
export function dedupeTitleKey(title: string): string | null {
  const key = title.slice(0, TITLE_LIMIT).normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\p{Z}\s]+/gu, ' ').trim();
  return key || null;
}

export interface DedupeItem {
  link: string;
  title: string;
  /** Publication time when known, otherwise when the item was first seen (ms). */
  time: number;
  firstSeenAt: string;
  /** Position of the member in the bundle. */
  member: number;
  /** Position in collection order; breaks every tie. */
  order: number;
}

/** Whether `a` is the copy to keep instead of `b`. */
function preferred(a: DedupeItem, b: DedupeItem, prefer: BundleDedupe['prefer']): boolean {
  if (prefer === 'order' && a.member !== b.member) return a.member < b.member;
  if (a.firstSeenAt !== b.firstSeenAt) return a.firstSeenAt < b.firstSeenAt;
  return a.order < b.order;
}

/**
 * For every item, the index of the copy kept for its group (itself when it
 * is kept). Groups are the connected sets of items that share a link key or
 * a title key, so a duplicate of a duplicate is found as well. Everything is
 * hash-based, one pass per rule: linear in the number of items (plus a sort
 * of the items sharing a title when a time window applies).
 */
export function findWinners(items: DedupeItem[], dedupe: BundleDedupe): number[] {
  const parent = items.map((_, index) => index);
  const find = (index: number): number => {
    while (parent[index] !== index) { parent[index] = parent[parent[index]]; index = parent[index]; }
    return index;
  };
  const union = (a: number, b: number) => { const x = find(a), y = find(b); if (x !== y) parent[Math.max(x, y)] = Math.min(x, y); };
  if (dedupe.mode !== 'off') {
    const keyOf = dedupe.mode === 'link' ? normalizeLink : dedupeUrlKey;
    const byLink = new Map<string, number>();
    items.forEach((item, index) => {
      const key = keyOf(item.link), first = byLink.get(key);
      if (first === undefined) byLink.set(key, index); else union(first, index);
    });
  }
  if (dedupe.mode === 'title') {
    const byTitle = new Map<string, number[]>();
    items.forEach((item, index) => {
      const key = dedupeTitleKey(item.title);
      if (key === null) return;
      const group = byTitle.get(key);
      if (group) group.push(index); else byTitle.set(key, [index]);
    });
    const window = dedupe.windowDays === null ? null : dedupe.windowDays * DAY_MS;
    for (const group of byTitle.values()) {
      if (group.length < 2) continue;
      if (window === null) { for (const index of group) union(group[0], index); continue; }
      // Same title, published at most `windowDays` apart from the next one in time.
      group.sort((a, b) => items[a].time - items[b].time || a - b);
      for (let i = 1; i < group.length; i++) if (items[group[i]].time - items[group[i - 1]].time <= window) union(group[i - 1], group[i]);
    }
  }
  const best = new Map<number, number>();
  items.forEach((item, index) => {
    const root = find(index), current = best.get(root);
    if (current === undefined || preferred(item, items[current], dedupe.prefer)) best.set(root, index);
  });
  return items.map((_, index) => best.get(find(index))!);
}

/** The rule that makes `removed` a duplicate of `kept`; `indirect` when only a third copy of the group links them. */
export function duplicateReason(kept: DedupeItem, removed: DedupeItem, dedupe: BundleDedupe): BundleMergeReason {
  if (normalizeLink(kept.link) === normalizeLink(removed.link)) return 'link';
  if (dedupe.mode !== 'link' && dedupeUrlKey(kept.link) === dedupeUrlKey(removed.link)) return 'url';
  if (dedupe.mode === 'title') {
    const key = dedupeTitleKey(kept.title);
    if (key !== null && key === dedupeTitleKey(removed.title) && (dedupe.windowDays === null || Math.abs(kept.time - removed.time) <= dedupe.windowDays * DAY_MS)) return 'title';
  }
  return 'indirect';
}
