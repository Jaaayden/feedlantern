import type { Page } from 'playwright';

// Trigger viewport-based reveal/lazy-loading without changing page styles or
// depending on a site's animation library. Keep the program independent of
// TypeScript runner helpers when Playwright serializes it into the page.
const SCROLL_PREPARATION = String.raw`async () => {
  const origin = { left: scrollX, top: scrollY };
  const started = Date.now();
  const pause = () => new Promise(resolve => setTimeout(resolve, 300));
  let previousHeight = -1;
  let stableBottom = 0;
  try {
    window.scrollTo({ left: origin.left, top: 0, behavior: 'instant' });
    for (let step = 0; step < 20 && Date.now() - started < 8000; step++) {
      window.scrollBy({ left: 0, top: Math.max(1, innerHeight * 0.8), behavior: 'instant' });
      await pause();
      const root = document.scrollingElement || document.documentElement;
      const height = root.scrollHeight;
      const atBottom = scrollY + innerHeight >= height - 2;
      stableBottom = atBottom && height === previousHeight ? stableBottom + 1 : 0;
      previousHeight = height;
      if (stableBottom >= 2) break;
    }
  } finally {
    window.scrollTo({ ...origin, behavior: 'instant' });
    await pause();
  }
}`;

export async function prepareScrollContent(page: Page): Promise<void> {
  await page.evaluate(`(${SCROLL_PREPARATION})()`);
}
