import { expect, request, test, type APIRequestContext } from '@playwright/test';
import { closeBrowser, createCredential, createFeed, detect, e2eBaseUrl, FIXTURE_URLS, getFeed, loginAsAdmin, openBrowser, protocolHeaders, setFixtureState, STATIC_RULES } from './support';

test.describe.serial('FeedLantern API acceptance', () => {
  let api: APIRequestContext;
  let csrfToken = '';

  test.beforeAll(async () => {
    api = await request.newContext({ baseURL: e2eBaseUrl });
    const auth = await loginAsAdmin(api);
    csrfToken = auth.csrfToken ?? '';
    expect(csrfToken).toBeTruthy();
  });

  test.afterAll(async () => {
    await api?.dispose();
  });

  test('management endpoints reject unauthenticated access', async () => {
    const anonymous = await request.newContext({ baseURL: e2eBaseUrl });
    const response = await anonymous.get('/api/feeds', { headers: protocolHeaders() });
    expect(response.status()).toBe(401);
    await anonymous.dispose();
  });

  test('detects all fields on a regular static card page and previews the same items', async () => {
    const browser = await openBrowser(api, csrfToken, FIXTURE_URLS.static);
    try {
      const result = await detect(api, csrfToken, browser.sessionId);
      expect(result.candidates.length).toBeGreaterThan(0);
      const candidate = result.candidates.find((entry) => entry.rules.title && entry.rules.link) ?? result.candidates[0];
      expect(candidate.count).toBeGreaterThanOrEqual(3);
      expect(candidate.rules.title).toBeTruthy();
      expect(candidate.rules.link).toBeTruthy();
      expect(candidate.items[0]).toMatchObject({
        title: 'Fixture article one',
        description: 'The first deterministic fixture article.',
        link: expect.stringContaining('/article/one'),
        image: expect.stringContaining('/assets/fixture-one.svg'),
        publishedAt: '2026-01-03T10:00:00.000Z',
      });

      const previewResponse = await api.post(`/api/browser/${encodeURIComponent(browser.sessionId)}/preview`, {
        headers: protocolHeaders(csrfToken),
        data: { rules: candidate.rules },
      });
      expect(previewResponse.ok()).toBeTruthy();
      const preview = (await previewResponse.json()) as { items: Array<{ title: string; link: string }> };
      expect(preview.items.map((item) => item.title)).toEqual(expect.arrayContaining(['Fixture article one', 'Fixture article two', 'Fixture article three']));
    } finally {
      await closeBrowser(api, csrfToken, browser.sessionId);
    }
  });

  test('supports non-semantic div cards and delayed dynamic content', async () => {
    const divBrowser = await openBrowser(api, csrfToken, FIXTURE_URLS.divCards);
    const dynamicBrowser = await openBrowser(api, csrfToken, FIXTURE_URLS.dynamic, null, 600);
    try {
      const divDetection = await detect(api, csrfToken, divBrowser.sessionId);
      expect(divDetection.candidates.some((candidate) => candidate.count >= 3 && candidate.items[0]?.title === 'Fixture article one')).toBeTruthy();

      const dynamicDetection = await detect(api, csrfToken, dynamicBrowser.sessionId);
      expect(dynamicDetection.candidates.some((candidate) => candidate.count >= 3 && candidate.items.some((item) => item.title === 'Fixture article two'))).toBeTruthy();
    } finally {
      await closeBrowser(api, csrfToken, divBrowser.sessionId);
      await closeBrowser(api, csrfToken, dynamicBrowser.sessionId);
    }
  });

  test('uses cookies without leaking their values and isolates missing credentials', async () => {
    const invalid = await createCredential(api, csrfToken, 'fl-auth=fixture-wrong', 'header', 'Fixture invalid credential');
    const validHeader = await createCredential(api, csrfToken, 'fl-auth=fixture-secret', 'header');
    const validJson = await createCredential(
      api,
      csrfToken,
      JSON.stringify([{ name: 'fl-auth', value: 'fixture-secret', domain: '127.0.0.1', path: '/', httpOnly: false, secure: false }]),
      'json',
      'Fixture JSON credential',
    );

    const credentialsResponse = await api.get('/api/credentials', { headers: protocolHeaders(csrfToken) });
    expect(credentialsResponse.ok()).toBeTruthy();
    const credentialsText = await credentialsResponse.text();
    expect(credentialsText).not.toContain('fixture-secret');

    const lockedBrowser = await openBrowser(api, csrfToken, FIXTURE_URLS.cookieGated, invalid.id);
    try {
      const locked = await detect(api, csrfToken, lockedBrowser.sessionId);
      expect(locked.candidates.every((candidate) => candidate.count === 0 || candidate.items.length === 0)).toBeTruthy();
    } finally {
      await closeBrowser(api, csrfToken, lockedBrowser.sessionId);
    }

    const headerBrowser = await openBrowser(api, csrfToken, FIXTURE_URLS.cookieGated, validHeader.id);
    try {
      const headerDetection = await detect(api, csrfToken, headerBrowser.sessionId);
      expect(headerDetection.candidates.some((candidate) => candidate.items.some((item) => item.title === 'Fixture article one'))).toBeTruthy();
    } finally {
      await closeBrowser(api, csrfToken, headerBrowser.sessionId);
    }

    const jsonBrowser = await openBrowser(api, csrfToken, FIXTURE_URLS.cookieGated, validJson.id);
    try {
      const jsonDetection = await detect(api, csrfToken, jsonBrowser.sessionId);
      expect(jsonDetection.candidates.some((candidate) => candidate.items.some((item) => item.title === 'Fixture article two'))).toBeTruthy();
    } finally {
      await closeBrowser(api, csrfToken, jsonBrowser.sessionId);
    }
  });

  test('reports ambiguous lists for user selection instead of silently choosing navigation noise', async () => {
    const browser = await openBrowser(api, csrfToken, FIXTURE_URLS.ambiguous);
    try {
      const result = await detect(api, csrfToken, browser.sessionId);
      expect(result.candidates.length).toBeGreaterThanOrEqual(2);
      expect(result.recommendedId).toBeNull();
      const viable = result.candidates.filter((candidate) => candidate.count >= 3);
      expect(viable.length).toBeGreaterThanOrEqual(2);
      expect(viable.every((candidate) => candidate.items[0]?.title === 'Fixture article one')).toBeTruthy();
    } finally {
      await closeBrowser(api, csrfToken, browser.sessionId);
    }
  });

  test('persists manual rule origins, emits RSS, and revokes the old token on rotation', async () => {
    const created = await createFeed(api, csrfToken, {
      name: 'Fixture static RSS',
      url: FIXTURE_URLS.static,
      rules: STATIC_RULES,
      ruleOrigins: { item: 'auto', title: 'manual', link: 'manual', description: 'auto', image: 'auto', date: 'auto' },
    });
    expect(created.feed.ruleOrigins).toMatchObject({ title: 'manual', link: 'manual' });

    const detail = await getFeed(api, csrfToken, created.feed.id);
    expect(detail.feed.ruleOrigins).toMatchObject({ title: 'manual', link: 'manual' });
    expect(detail.items.length).toBeGreaterThanOrEqual(3);

    const anonymous = await request.newContext({ baseURL: e2eBaseUrl });
    const oldRss = await anonymous.get(created.feedUrl);
    expect(oldRss.status()).toBe(200);
    const oldXml = await oldRss.text();
    expect(oldXml).toContain('Fixture article one');

    const rotate = await api.post(`/api/feeds/${encodeURIComponent(created.feed.id)}/rotate-token`, {
      headers: protocolHeaders(csrfToken),
      data: {},
    });
    expect(rotate.ok()).toBeTruthy();
    const rotated = (await rotate.json()) as { feedUrl: string };
    expect(rotated.feedUrl).not.toBe(created.feedUrl);

    const revoked = await anonymous.get(created.feedUrl);
    expect([401, 403, 404]).toContain(revoked.status());
    const current = await anonymous.get(rotated.feedUrl);
    expect(current.status()).toBe(200);
    await anonymous.dispose();
  });

  test('retains previous items after a failed refresh and recovers after the page returns', async () => {
    await setFixtureState({ failure: false, version: 1 });
    const created = await createFeed(api, csrfToken, {
      name: 'Fixture failure retention',
      url: FIXTURE_URLS.versioned,
      rules: { ...STATIC_RULES },
    });
    const before = await getFeed(api, csrfToken, created.feed.id);
    expect(before.items.length).toBeGreaterThanOrEqual(3);
    const beforeIds = before.items.map((item) => item.link).sort();

    await setFixtureState({ failure: true });
    const failedRefresh = await api.post(`/api/feeds/${encodeURIComponent(created.feed.id)}/refresh`, {
      headers: protocolHeaders(csrfToken),
      data: {},
    });
    expect([200, 204, 500, 502, 503]).toContain(failedRefresh.status());
    const afterFailure = await getFeed(api, csrfToken, created.feed.id);
    expect(afterFailure.items.map((item) => item.link).sort()).toEqual(beforeIds);
    expect(afterFailure.feed.lastError).toBeTruthy();

    await setFixtureState({ failure: false, version: 2 });
    const recovered = await api.post(`/api/feeds/${encodeURIComponent(created.feed.id)}/refresh`, {
      headers: protocolHeaders(csrfToken),
      data: {},
    });
    expect(recovered.ok()).toBeTruthy();
    const afterRecovery = await getFeed(api, csrfToken, created.feed.id);
    expect(afterRecovery.feed.lastError).toBeNull();
    expect(afterRecovery.items.some((item) => item.title === 'Updated Fixture article one')).toBeTruthy();
  });

  test('blocks redirects outside the exact target allowlist', async () => {
    const response = await api.post('/api/browser', {
      headers: protocolHeaders(csrfToken),
      data: { url: FIXTURE_URLS.redirect, credentialId: null, waitMs: 100 },
    });
    expect(response.ok()).toBeFalsy();
    expect([400, 403, 422, 502]).toContain(response.status());
  });
});
