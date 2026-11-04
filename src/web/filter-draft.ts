import type { ItemFilter } from '../shared/types';

/** One keyword or pattern per line; blank lines and repeats are dropped, as the server does. */
export const filterLines = (value: string) => [...new Set(value.split('\n').map(line => line.trim()).filter(Boolean))];

/** The filter a settings form describes, or null when it has no keywords. */
export function draftFilter(include: string, exclude: string, regex: boolean): ItemFilter | null {
  const draft = { include: filterLines(include), exclude: filterLines(exclude), regex };
  return draft.include.length || draft.exclude.length ? draft : null;
}
