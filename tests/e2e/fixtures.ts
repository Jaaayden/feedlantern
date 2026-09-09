import { test as base, expect } from '@playwright/test';

// Closing a Playwright context does not guarantee delivery of pagehide fetches.
// Release remote editors before the local page/context is destroyed, including
// on assertion failures and retries. Only clean up sessions opened by this test.
export const test = base.extend<{ remoteEditors: void }>({
  remoteEditors: [async ({ page }, use) => {
    const sessions = new Map<string, string>();
    const pending = new Set<Promise<void>>();
    const record = (response: import('@playwright/test').Response) => {
      const request = response.request();
      if (request.method() !== 'POST' || new URL(response.url()).pathname !== '/api/browser' || !response.ok()) return;
      const task = (async () => {
        const body = await response.json();
        if (typeof body.sessionId === 'string') sessions.set(body.sessionId, request.headers()['x-csrf-token']);
      })();
      pending.add(task);
      void task.catch(() => {}).finally(() => pending.delete(task));
    };
    page.on('response', record);
    try { await use(); }
    finally {
      await Promise.allSettled([...pending]);
      page.off('response', record);
      for (const [id, csrf] of sessions) {
        const response = await page.request.delete(`/api/browser/${encodeURIComponent(id)}`, {
          headers: { 'X-FeedLantern': '1', 'X-CSRF-Token': csrf },
        });
        expect(response.ok(), `释放编辑会话 ${id}: ${response.status()}`).toBeTruthy();
      }
    }
  }, { auto: true }],
});
export { expect };
