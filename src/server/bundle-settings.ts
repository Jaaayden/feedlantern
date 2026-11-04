import { BUNDLE_DEDUPE_DEFAULT, BUNDLE_DEDUPE_MODES, BUNDLE_DEDUPE_PREFER, BUNDLE_DEDUPE_WINDOW, type BundleDedupe, type BundleFilter } from '../shared/types.js';
import { ItemFilterError, parseItemFilter } from './feed-output.js';
import { msg } from './i18n.js';

/**
 * Validation of a bundle's deduplication and filter, shared by the API, the
 * configuration file and the backup. The filter itself is the feeds' own
 * (`parseItemFilter`): same limits, same regex safety check.
 */

/** Merge a (partial) setting onto `base`; anything unknown or out of range is rejected. */
export function parseBundleDedupe(value: unknown, base: BundleDedupe = BUNDLE_DEDUPE_DEFAULT): BundleDedupe {
  if (value === undefined || value === null) return { ...base };
  if (typeof value !== 'object' || Array.isArray(value)) throw new ItemFilterError(msg('error.bundleDedupeInvalid'));
  const record = value as Record<string, unknown>;
  const dedupe = { ...base };
  if (record.mode !== undefined) {
    if (!BUNDLE_DEDUPE_MODES.includes(record.mode as never)) throw new ItemFilterError(msg('error.bundleDedupeInvalid'));
    dedupe.mode = record.mode as BundleDedupe['mode'];
  }
  if (record.prefer !== undefined) {
    if (!BUNDLE_DEDUPE_PREFER.includes(record.prefer as never)) throw new ItemFilterError(msg('error.bundleDedupeInvalid'));
    dedupe.prefer = record.prefer as BundleDedupe['prefer'];
  }
  if (record.windowDays !== undefined) {
    const days = record.windowDays;
    if (days !== null && (typeof days !== 'number' || !Number.isInteger(days) || days < BUNDLE_DEDUPE_WINDOW.min || days > BUNDLE_DEDUPE_WINDOW.max)) {
      throw new ItemFilterError(msg('error.bundleDedupeWindow', { min: BUNDLE_DEDUPE_WINDOW.min, max: BUNDLE_DEDUPE_WINDOW.max }));
    }
    dedupe.windowDays = days;
  }
  // The window only has a meaning for titles; keeping it elsewhere would let a hidden value come back later.
  if (dedupe.mode !== 'title') dedupe.windowDays = null;
  return dedupe;
}

/** A bundle filter is a feed filter plus `matchSource`. Empty filters become null. */
export function parseBundleFilter(value: unknown): BundleFilter | null {
  if (value === undefined || value === null) return null;
  const filter = parseItemFilter(value);
  const matchSource = (value as Record<string, unknown>).matchSource;
  if (matchSource !== undefined && typeof matchSource !== 'boolean') throw new ItemFilterError(msg('filter.invalid'));
  return filter ? { ...filter, matchSource: matchSource === true } : null;
}

/** Read a stored column: damaged or missing JSON means the default, never an error while serving a feed. */
export function storedBundleDedupe(json: unknown): BundleDedupe {
  try { return typeof json === 'string' && json ? parseBundleDedupe(JSON.parse(json)) : { ...BUNDLE_DEDUPE_DEFAULT }; } catch { return { ...BUNDLE_DEDUPE_DEFAULT }; }
}
export function storedBundleFilter(json: unknown): BundleFilter | null {
  try { return typeof json === 'string' && json ? parseBundleFilter(JSON.parse(json)) : null; } catch { return null; }
}
