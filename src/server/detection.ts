import type { Page } from 'playwright';

import type {
  DetectionCandidate,
  DetectionResult,
  ExtractedItem,
  Rect,
  SelectionRules,
} from '../shared/types';
import { extractPage } from './extraction';

const MAX_DISCOVERY_NODES = 2_000;
const MAX_ITEMS = 200;
const MAX_CANDIDATES_TO_EXTRACT = 12;

interface DiscoveredCandidate {
  label: string;
  rules: SelectionRules;
  score: number;
  count: number;
  rects: Rect[];
  warnings: string[];
  titleHintCoverage: number;
  linkHintCoverage: number;
}

/**
 * Discovers list-like structures in the rendered page and proposes stable
 * selection rules.  The discovery phase is intentionally a read-only
 * `evaluate`; extraction is delegated to `extractPage` so that previews and
 * scheduled fetches use the same semantics.
 */
export async function detectPage(page: Page): Promise<DetectionResult> {
  let discovered: DiscoveredCandidate[];

  try {
    discovered = await page.evaluate((limits) => {
      type LocalField = 'title' | 'link' | 'description' | 'image' | 'date';
      type LocalRules = {
        item: string;
        title: string;
        link: string;
        description?: string;
        image?: string;
        date?: string;
      };
      type LocalRect = { x: number; y: number; width: number; height: number };
      type LocalCandidate = {
        label: string;
        rules: LocalRules;
        score: number;
        count: number;
        rects: LocalRect[];
        warnings: string[];
        titleHintCoverage: number;
        linkHintCoverage: number;
      };

      const tokenPattern = /^[a-zA-Z_][a-zA-Z0-9_-]{0,42}$/;
      const dynamicTokenPattern = /(?:^|[-_])(?:[a-f0-9]{6,}|\d{3,})(?:$|[-_])/i;
      const semanticWords = /(?:title|headline|subject|name|story|article|post|entry|card|item|result|row|thing|content|summary|excerpt|description|abstract|date|time|published|created|author)/i;
      const blockedWords = /(?:^|[-_\s])(?:ad|ads|advert|advertisement|sponsor|promoted|share|social|breadcrumb|path|pos|position|pagination|pager|cookie|consent|newsletter|related|sidebar)(?:$|[-_\s])/i;
      const datePattern = /(?:刚刚|\bjust\s+now\b|\d+\s*(?:秒钟?|分钟?|小时|天|周)\s*前|\b\d+\s*(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?)\s+ago\b|\b(?:19|20)\d{2}[./-]\d{1,2}(?:[./-]\d{1,2})?\b|\b\d{1,2}[./-]\d{1,2}[./-](?:19|20)?\d{2}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b\d{1,2}\s+(?:小时|天|周|月|年前|minutes?|hours?|days?|weeks?|months?)\b|\b\d{4}年\d{1,2}月)/i;

      const helpers = {
        clamp(value: number, min = 0, max = 1): number {
          return Math.max(min, Math.min(max, value));
        },
        text(value: string | null | undefined): string {
          return (value ?? '').replace(/\s+/g, ' ').trim();
        },
        lower(value: string | null | undefined): string {
          return text(value).toLowerCase();
        },
        stableClassNames(element: Element): string[] {
          return Array.from(element.classList)
            .filter((name) => tokenPattern.test(name) && !dynamicTokenPattern.test(name))
            .filter((name) => !/^(?:n|item|row|post|news)[-_]?\d+$/i.test(name))
            .filter((name) => !/^(?:animated|animate__animated|aos-animate)$/.test(name))
            .filter((name) => name.length <= 42)
            .slice(0, 6);
        },

        escaped(value: string): string {
          if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
          return value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
        },

        simpleSelector(element: Element, includeId = true): string {
        const htmlElement = element as HTMLElement;
        const id = text(htmlElement.id);
        if (includeId && id && tokenPattern.test(id) && !dynamicTokenPattern.test(id)) {
          try {
            if (document.querySelectorAll(`#${escaped(id)}`).length === 1) return `#${escaped(id)}`;
          } catch {
            // Fall through to a tag/class selector.
          }
        }

        const tag = element.tagName.toLowerCase();
        const classes = stableClassNames(element)
          .filter((name) => semanticWords.test(name) || stableClassNames(element).length <= 2)
          .slice(0, 3)
          .map((name) => `.${escaped(name)}`)
          .join('');
        return `${tag}${classes}`;
        },

        nearestRegion(element: Element): Element | null {
        let current: Element | null = element;
        while (current && current !== document.body) {
          const tag = current.tagName.toLowerCase();
          if (tag === 'main' || tag === 'article' || tag === 'section' || tag === 'body') return current;
          current = current.parentElement;
        }
        return document.body;
        },

        blockedByContext(element: Element): boolean {
        let current: Element | null = element;
        while (current && current !== document.body) {
          const tag = current.tagName.toLowerCase();
          const role = lower(current.getAttribute('role'));
          const signal = `${tag} ${current.className || ''} ${(current as HTMLElement).id || ''} ${role} ${current.getAttribute('aria-label') || ''}`;
          if (tag === 'nav' || tag === 'footer' || tag === 'header' || tag === 'aside') return true;
          if (blockedWords.test(signal) && tag !== 'main' && tag !== 'article') return true;
          current = current.parentElement;
        }
        return false;
        },

        visible(element: Element): boolean {
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
        },

        candidateLike(element: Element): boolean {
        const tag = element.tagName.toLowerCase();
        if (['script', 'style', 'noscript', 'template', 'svg', 'option', 'path', 'meta', 'link'].includes(tag)) return false;
        if (blockedByContext(element) || !visible(element)) return false;
        const signal = `${tag} ${element.className || ''} ${(element as HTMLElement).id || ''} ${element.getAttribute('role') || ''}`;
        const meaningfulTag = tag === 'article' || tag === 'li' || tag === 'tr';
        const semanticSignal = semanticWords.test(signal);
        const link = element.querySelector('a[href]');
        const ownText = text(element.textContent);
        const cardLike = tag === 'div' && Boolean(link) && ownText.length >= 12 && ownText.length <= 2_000;
        const anchorCardLike = tag === 'a' && Boolean(element.getAttribute('href')) && ownText.length >= 2 && ownText.length <= 240;
        return meaningfulTag || semanticSignal || cardLike || anchorCardLike;
        },

        directShape(element: Element): string {
        const children = Array.from(element.children).slice(0, 12).map((child) => child.tagName.toLowerCase());
        const linkCount = element.querySelectorAll('a[href]').length;
        const headingCount = element.querySelectorAll('h1,h2,h3,h4,h5,h6').length;
        const imageCount = element.querySelectorAll('img,source').length;
        return `${children.join(',')}/${linkCount}/${headingCount}/${imageCount}`;
        },

        regionShape(element: Element): string {
        const region = nearestRegion(element);
        if (!region) return 'body';
        return `${region.tagName.toLowerCase()}|${stableClassNames(region).slice(0, 2).join('.')}`;
        },

        commonClasses(group: Element[]): string[] {
        if (group.length === 0) return [];
        const sets = group.map((element) => new Set(stableClassNames(element)));
        return Array.from(sets[0]).filter((name) => sets.every((set) => set.has(name)));
        },

        sameElements(a: Element[], b: Element[]): boolean {
        if (a.length !== b.length) return false;
        const bSet = new Set(b);
        return a.every((element) => bSet.has(element));
        },

        selectorMatchesGroup(selector: string, group: Element[]): Element[] {
        try {
          const all = Array.from(document.querySelectorAll(selector));
          // Saved selectors are replayed by the shared extractor without
          // discovery's visibility/context filter. Reject selectors that
          // would expand into a footer or hidden panel when replayed.
          if (all.some(element => blockedByContext(element) || !visible(element))) return [];
          return all.slice(0, limits.maxItems);
        } catch {
          return [];
        }
        },

        parentScopeSelector(element: Element): string | null {
        let current = element.parentElement;
        const path: string[] = [];
        let depth = 0;
        while (current && depth < 8) {
          path.unshift(simpleSelector(current));
          const selector = path.join(' > ');
          try {
            if (document.querySelectorAll(selector).length === 1) return selector;
          } catch {
            // Continue with the next ancestor, preserving the parent path.
          }
          if (current === document.body) break;
          current = current.parentElement;
          depth += 1;
        }
        return null;
        },

        buildItemSelector(group: Element[]): { selector: string; matches: Element[] } | null {
        const first = group[0];
        const tag = first.tagName.toLowerCase();
        const classes = commonClasses(group)
          .filter((name) => semanticWords.test(name) || commonClasses(group).length <= 2)
          .slice(0, 3)
          .map((name) => `.${escaped(name)}`)
          .join('');
        const base = `${tag}${classes}`;
        const options: string[] = [base];

        const sameParent = group.every((element) => element.parentElement === first.parentElement);
        if (sameParent && first.parentElement) {
          const parent = parentScopeSelector(first);
          if (parent) options.unshift(`${parent} > ${base}`);
          if (parent && !classes) options.unshift(`${parent} > ${tag}`);
        }

        let current: Element | null = first.parentElement;
        let depth = 0;
        while (current && current !== document.body && depth < 3) {
          const ancestor = simpleSelector(current);
          options.push(`${ancestor} ${base}`);
          current = current.parentElement;
          depth += 1;
        }

        const tried = new Set<string>();
        for (const selector of options) {
          if (tried.has(selector)) continue;
          tried.add(selector);
          const matches = selectorMatchesGroup(selector, group);
          if (matches.length >= 3 && matches.length <= limits.maxItems && group.every((element) => matches.includes(element))) {
            if (sameElements(matches, group) || matches.length <= Math.ceil(group.length * 1.25)) {
              return { selector, matches };
            }
          }
        }
        return null;
        },

        selectorSegment(element: Element): string {
        const tag = element.tagName.toLowerCase();
        const classes = stableClassNames(element)
          .filter((name) => semanticWords.test(name) || stableClassNames(element).length <= 2)
          .slice(0, 2)
          .map((name) => `.${escaped(name)}`)
          .join('');
        return `${tag}${classes}`;
        },

        relativePath(item: Element, target: Element): string | null {
        if (item === target) return ':scope';
        const segments: string[] = [];
        let current: Element | null = target;
        let depth = 0;
        while (current && current !== item && depth < 8) {
          segments.unshift(selectorSegment(current));
          current = current.parentElement;
          depth += 1;
        }
        if (current !== item || segments.length === 0) return null;
        const selector = `:scope > ${segments.join(' > ')}`;
        if (item.querySelector(selector) === target) return selector;
        // Identical classless siblings (for example date then summary <p>)
        // must not collapse to a selector that always returns the first one.
        const precise: string[] = [];
        current = target;
        while (current && current !== item) {
          const siblings = Array.from(current.parentElement?.children ?? []).filter(sibling => sibling.tagName === current!.tagName);
          precise.unshift(`${selectorSegment(current)}:nth-of-type(${siblings.indexOf(current) + 1})`);
          current = current.parentElement;
        }
        return `:scope > ${precise.join(' > ')}`;
        },

        isDateLike(element: Element): boolean {
        const tag = element.tagName.toLowerCase();
        const signal = `${element.className || ''} ${(element as HTMLElement).id || ''} ${element.getAttribute('aria-label') || ''}`;
        return tag === 'time' || Boolean(element.getAttribute('datetime')) || /date|time|publish|created|updated/i.test(signal) || datePattern.test(text(element.textContent));
        },

        fieldRank(field: LocalField, element: Element): number {
        const tag = element.tagName.toLowerCase();
        const signal = `${element.className || ''} ${(element as HTMLElement).id || ''} ${element.getAttribute('data-testid') || ''}`;
        const value = text(element.textContent);
        if (!value && field !== 'image' && field !== 'link') return -100;
        if (field === 'title') {
          const semanticTitle = /title|headline|subject|story|name|(?:^|[-_\s])f?ttl(?:$|[-_\s])/i.test(signal);
          const metadataSignal = /meta|metadata|date|time|publish|created|updated|author|byline|category|tag|label|type/i.test(signal);
          const metadataParent = element.parentElement?.closest('[class*="meta"],time,[datetime]');
          if (metadataParent && !semanticTitle) return -6;
          const dateLike = isDateLike(element) || Boolean(element.querySelector('time,[datetime]'));
          // A card often contains a date/category heading before its actual
          // title. Prefer a link explicitly marked as the title, while
          // lowering metadata headings and date-like text. This is generic:
          // it does not depend on a site's class names.
          if (tag === 'a' && element.getAttribute('href') && semanticTitle) return 16;
          if (tag === 'a' && element.getAttribute('href') && !dateLike) return 10;
          if (dateLike || metadataSignal) return semanticTitle ? 8 : -6;
          if (/^h[1-6]$/.test(tag)) return 12;
          if (semanticTitle) return 11;
          return value.length >= 4 && value.length <= 240 ? 4 : -1;
        }
        if (field === 'link') {
          if (tag !== 'a' || !element.getAttribute('href')) return -100;
          const href = element.getAttribute('href') || '';
          return /^https?:|^\//i.test(href) ? (/title|story|headline|item|link/i.test(signal) ? 12 : 9) : 3;
        }
        if (field === 'description') {
          if (isDateLike(element) || /title|headline|meta|author|byline|category/i.test(signal)) return -1;
          if (/description|summary|excerpt|abstract|dek|lead/i.test(signal)) return 11;
          if (tag === 'p') return value.length >= 15 ? 9 : 5;
          if (tag === 'a' || /^h[1-6]$/.test(tag)) return -1;
          return value.length >= 30 && value.length <= 600 ? 3 : -1;
        }
        if (field === 'image') {
          if (tag === 'img' || tag === 'source') return 12;
          return element.querySelector('img,source') ? 7 : -1;
        }
        if (field === 'date') {
          if (tag !== 'time' && !element.getAttribute('datetime') && /title|headline|subject|(?:^|[-_\s])f?ttl(?:$|[-_\s])/i.test(signal)) return -1;
          if (element.querySelector('time,[datetime],h1,h2,h3,p,a')) return -1;
          if ((tag === 'a' || /^h[1-6]$/.test(tag)) && !/date|time|publish|created|updated/i.test(signal)) return -1;
          const direct = Array.from(element.childNodes).filter(node => node.nodeType === 3).map(node => node.textContent).join(' ');
          return isDateLike(element) ? (tag === 'time' || element.getAttribute('datetime') ? 12 : datePattern.test(direct) ? 10 : 8) : -1;
        }
        return -1;
        },

        fieldTargets(item: Element, field: LocalField): Element[] {
        const descendants = [item, ...Array.from(item.querySelectorAll('*')).slice(0, 119)];
        return descendants.filter((element) => {
          if (element === item && field === 'description') {
            const signal = `${element.className || ''} ${(element as HTMLElement).id || ''}`;
            if (!/description|summary|excerpt|abstract|dek|lead/i.test(signal)) return false;
          }
          if (element === item && field === 'date' && element.tagName.toLowerCase() !== 'time' && !element.getAttribute('datetime')) {
            const signal = `${element.className || ''} ${(element as HTMLElement).id || ''}`;
            if (!/date|time|publish|created|updated/i.test(signal)) return false;
          }
          return fieldRank(field, element) >= 0;
        });
        },

        inferField(group: Element[], field: LocalField): { selector?: string; coverage: number; score: number } {
        const byPath = new Map<string, { elements: Set<Element>; score: number; count: number }>();
        for (const item of group) {
          const paths = new Map<string, number>();
          for (const target of fieldTargets(item, field)) {
            const path = relativePath(item, target);
            if (!path) continue;
            const rank = fieldRank(field, target);
            paths.set(path, Math.max(paths.get(path) ?? -100, rank));
          }
          for (const [path, rank] of paths) {
            const record = byPath.get(path) || { elements: new Set<Element>(), score: 0, count: 0 };
            record.elements.add(item);
            record.score += rank;
            record.count += 1;
            byPath.set(path, record);
          }
        }
        let best: { path: string; coverage: number; score: number } | null = null;
        for (const [path, record] of byPath) {
          const coverage = record.elements.size / Math.max(1, group.length);
          // For titles, semantic strength matters slightly more than a
          // generic text node that happens to occur in every row. This keeps
          // a real title link with one missing row ahead of a repeated
          // date/category label, while still requiring broad coverage for a
          // high-confidence candidate later.
          const coverageWeight = field === 'title' ? 0.6 : 0.75;
          const rankWeight = 1 - coverageWeight;
          const score = coverage * coverageWeight + clamp(record.score / Math.max(1, record.count * 12)) * rankWeight;
          if (!best || score > best.score || (score === best.score && coverage > best.coverage)) {
            best = { path, coverage, score };
          }
        }
        if (!best) return { coverage: 0, score: 0 };
        return { selector: best.path, coverage: best.coverage, score: best.score };
        },
      };

      const {
        clamp,
        text,
        lower,
        stableClassNames,
        escaped,
        simpleSelector,
        nearestRegion,
        blockedByContext,
        visible,
        candidateLike,
        directShape,
        regionShape,
        commonClasses,
        sameElements,
        selectorMatchesGroup,
        parentScopeSelector,
        buildItemSelector,
        selectorSegment,
        relativePath,
        isDateLike,
        fieldRank,
        fieldTargets,
        inferField,
      } = helpers;

      const elements = Array.from(document.querySelectorAll('*')).slice(0, limits.maxNodes);
      const eligible = elements.filter(candidateLike);
      const groups = new Map<string, Element[]>();
      for (const element of eligible) {
        const tag = element.tagName.toLowerCase();
        const classes = stableClassNames(element);
        const parent = element.parentElement;
        const parentId = parent && tokenPattern.test((parent as HTMLElement).id || '') && !dynamicTokenPattern.test((parent as HTMLElement).id || '')
          ? `#${(parent as HTMLElement).id}`
          : '';
        const parentShape = parent ? `${parent.tagName.toLowerCase()}|${stableClassNames(parent).slice(0, 3).join('.')}|${parentId}` : 'root';
        const shape = classes.length > 0 ? classes.slice(0, 4).join('.') : directShape(element);
        const key = `${tag}|${shape}|${parentShape}|${regionShape(element)}`;
        const group = groups.get(key);
        if (group) group.push(element);
        else groups.set(key, [element]);
      }

      const rawCandidates: Array<LocalCandidate & { elements: Element[] }> = [];
      for (const group of groups.values()) {
        if (group.length < 3) continue;
        const built = buildItemSelector(group);
        if (!built) continue;
        const matched = built.matches.slice(0, limits.maxItems);
        if (matched.length < 3) continue;

        const title = inferField(matched, 'title');
        const link = inferField(matched, 'link');
        const description = inferField(matched, 'description');
        const image = inferField(matched, 'image');
        const date = inferField(matched, 'date');
        const titleSelector = title.selector || ':scope h1, :scope h2, :scope h3, :scope h4, :scope h5, :scope h6, :scope a';
        const linkSelector = link.selector || ':scope a[href]';
        const rules: LocalRules = {
          item: built.selector,
          title: titleSelector,
          link: linkSelector,
          ...(description.selector && description.coverage >= 0.25 ? { description: description.selector } : {}),
          ...(image.selector && image.coverage >= 0.25 ? { image: image.selector } : {}),
          ...(date.selector && date.coverage >= 0.25 ? { date: date.selector } : {}),
        };

        const regionScore = matched.reduce((sum, element) => {
          const region = nearestRegion(element);
          const tag = region?.tagName.toLowerCase();
          return sum + (tag === 'main' ? 1 : tag === 'article' ? 0.85 : tag === 'section' ? 0.7 : 0.45);
        }, 0) / matched.length;
        const semanticScore = matched.reduce((sum, element) => {
          const tag = element.tagName.toLowerCase();
          const signal = `${tag} ${element.className || ''}`;
          return sum + (tag === 'article' || tag === 'li' || tag === 'tr' ? 1 : semanticWords.test(signal) ? 0.7 : 0.4);
        }, 0) / matched.length;
        const repeatedScore = clamp(matched.length / 8);
        const score = clamp(
          regionScore * 0.26 +
          repeatedScore * 0.2 +
          title.coverage * 0.22 +
          link.coverage * 0.22 +
          semanticScore * 0.1,
        );
        const firstTitle = title.selector ? text(matched[0].querySelector(title.selector)?.textContent) : '';
        const label = firstTitle ? firstTitle.slice(0, 80) : `${matched[0].tagName.toLowerCase()} 列表`;
        const warnings: string[] = [];
        if (title.coverage < 0.8) warnings.push('标题字段只在部分条目中匹配');
        if (link.coverage < 0.8) warnings.push('链接字段只在部分条目中匹配');
        if (!description.selector || description.coverage < 0.5) warnings.push('未稳定识别摘要字段');
        if (!image.selector || image.coverage < 0.5) warnings.push('未稳定识别图片字段');
        if (!date.selector || date.coverage < 0.5) warnings.push('未稳定识别日期字段');
        const rects = matched.slice(0, limits.maxItems).map((element) => {
          const rect = element.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        });
        rawCandidates.push({
          label,
          rules,
          score,
          count: matched.length,
          rects,
          warnings,
          titleHintCoverage: title.coverage,
          linkHintCoverage: link.coverage,
          elements: matched,
        });
      }

      rawCandidates.sort((a, b) => b.score - a.score || b.count - a.count);

      // Keep distinct item sets only.  This removes a generic outer `div` and
      // its nested `article` candidate when both describe the same list.
      const distinct: typeof rawCandidates = [];
      for (const candidate of rawCandidates) {
        const duplicate = distinct.find((existing) => {
          const overlap = candidate.elements.filter((element) => new Set(existing.elements).has(element)).length;
          const smaller = Math.min(candidate.elements.length, existing.elements.length);
          if (smaller > 0 && overlap / smaller >= 0.8) return true;

          // A repeated heading/paragraph/link inside every card is a nested
          // candidate for the same list.  Treat it as a duplicate when each
          // element in one set is contained by an element in the other set.
          const candidateInsideExisting = candidate.elements.filter((element) =>
            existing.elements.some((parent) => parent !== element && parent.contains(element)),
          ).length / Math.max(1, candidate.elements.length);
          const existingInsideCandidate = existing.elements.filter((element) =>
            candidate.elements.some((parent) => parent !== element && parent.contains(element)),
          ).length / Math.max(1, existing.elements.length);
          return candidateInsideExisting >= 0.8 || existingInsideCandidate >= 0.8;
        });
        if (!duplicate) distinct.push(candidate);
        else if (candidate.score > duplicate.score) {
          const index = distinct.indexOf(duplicate);
          distinct[index] = candidate;
        }
      }

      return distinct.slice(0, limits.maxCandidates).map(({ elements: _elements, ...candidate }) => candidate) as LocalCandidate[];
    }, { maxNodes: MAX_DISCOVERY_NODES, maxItems: MAX_ITEMS, maxCandidates: MAX_CANDIDATES_TO_EXTRACT });
  } catch (error) {
    return {
      candidates: [],
      recommendedId: null,
      warnings: [`无法分析当前页面：${error instanceof Error ? error.message : '页面已关闭或不可用'}`],
    };
  }

  if (discovered.length === 0) {
    return {
      candidates: [],
      recommendedId: null,
      warnings: ['未找到包含重复条目、标题和链接的内容列表；可以使用手动选择器调整。'],
    };
  }

  const evaluated: Array<{ discovery: DiscoveredCandidate; items: ExtractedItem[]; score: number; warnings: string[] }> = [];
  for (const discovery of discovered) {
    let items: ExtractedItem[] = [];
    try {
      items = (await extractPage(page, discovery.rules)).slice(0, MAX_ITEMS);
    } catch {
      evaluated.push({
        discovery,
        items: [],
        score: discovery.score * 0.25,
        warnings: [...discovery.warnings, '按当前规则无法提取条目，请手动调整选择器'],
      });
      continue;
    }

    // `extractPage` intentionally drops rows without a usable title/link.
    // Use the number of rows found during discovery as the denominator so
    // those dropped rows still reduce confidence instead of making every
    // successful extraction look like 100% coverage.
    const discoveryCount = Math.max(1, discovery.count);
    const titleCoverage = items.filter((item) => item.title.trim().length > 0).length / discoveryCount;
    const linkItems = items.filter((item) => item.link.trim().length > 0);
    const linkCoverage = linkItems.length / discoveryCount;
    const uniqueLinks = new Set(linkItems.map((item) => item.link)).size;
    const uniqueRatio = linkItems.length === 0 ? 0 : uniqueLinks / linkItems.length;
    const titleValues = items.map((item) => item.title.trim().replace(/\s+/g, ' ').toLocaleLowerCase()).filter(Boolean);
    const uniqueTitles = new Set(titleValues).size;
    const titleDistinctRatio = titleValues.length === 0 ? 0 : uniqueTitles / titleValues.length;
    const countScore = Math.min(1, items.length / 8);
    const repetitionPenalty = titleDistinctRatio < 0.5 ? 0.15 : titleDistinctRatio < 0.75 ? 0.05 : 0;
    // A list of bare links is equally navigation-like whether each item
    // is the anchor itself or a wrapper containing that same anchor.
    const bareLinksPenalty = discovery.rules.title === discovery.rules.link
      && !discovery.rules.date && !discovery.rules.image && !discovery.rules.description ? 0.15 : 0;
    const score = Math.max(0, Math.min(1,
      discovery.score * 0.35 +
      titleCoverage * 0.25 +
      linkCoverage * 0.25 +
      uniqueRatio * 0.1 +
      countScore * 0.05 -
      repetitionPenalty - bareLinksPenalty,
    ));
    const warnings = [...discovery.warnings];
    if (items.length < 3) warnings.push('匹配条目少于 3 个，建议人工确认');
    if (titleCoverage < 0.8) warnings.push('标题覆盖率不足 80%');
    if (linkCoverage < 0.8) warnings.push('有效链接覆盖率不足 80%');
    if (uniqueRatio < 0.8) warnings.push('链接重复较多，可能匹配到了导航或操作按钮');
    if (discovery.count >= 3 && titleValues.length >= 2 && titleDistinctRatio <= 0.5) warnings.push('标题重复较多，可能匹配到了日期或分类元信息');
    evaluated.push({ discovery, items, score, warnings: Array.from(new Set(warnings)) });
  }

  evaluated.sort((a, b) => b.score - a.score || b.items.length - a.items.length);
  const candidates: DetectionCandidate[] = evaluated.slice(0, 3).map((entry, index) => {
    const discoveryCount = Math.max(1, entry.discovery.count);
    const titleCoverage = entry.items.filter((item) => item.title.trim()).length / discoveryCount;
    const links = entry.items.filter((item) => item.link.trim());
    const linkCoverage = links.length / discoveryCount;
    const uniqueRatio = links.length === 0 ? 0 : new Set(links.map((item) => item.link)).size / links.length;
    const titleValues = entry.items.map((item) => item.title.trim().replace(/\s+/g, ' ').toLocaleLowerCase()).filter(Boolean);
    const titleDistinctRatio = titleValues.length === 0 ? 0 : new Set(titleValues).size / titleValues.length;
    const high = entry.items.length >= 3 && titleCoverage >= 0.8 && linkCoverage >= 0.8 && uniqueRatio >= 0.8 && titleDistinctRatio >= 0.5;
    const medium = entry.items.length >= 3 && titleCoverage >= 0.5 && linkCoverage >= 0.5;
    return {
      id: `candidate-${index + 1}`,
      label: entry.discovery.label || `候选列表 ${index + 1}`,
      rules: entry.discovery.rules,
      confidence: high ? 'high' : medium ? 'medium' : 'low',
      score: Number(entry.score.toFixed(4)),
      count: entry.items.length,
      items: entry.items,
      rects: entry.discovery.rects,
      warnings: entry.warnings,
    };
  });

  const top = candidates[0];
  const second = candidates[1];
  const topIsHigh = top?.confidence === 'high';
  const clearlyAhead = Boolean(top && (!second || top.score - second.score >= 0.1));
  const recommendedId = top && topIsHigh && clearlyAhead ? top.id : null;
  const warnings: string[] = [];
  if (!recommendedId) {
    if (candidates.length > 1) warnings.push('存在多个相近的内容列表，请选择要生成订阅的候选。');
    else warnings.push('未达到自动推荐的可信度，请确认或调整匹配规则。');
  }

  return { candidates, recommendedId, warnings };
}
