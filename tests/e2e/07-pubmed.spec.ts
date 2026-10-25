import { test, expect } from './fixtures';
import { loginAsAdmin, protocolHeaders } from './support';
import { fixtureBaseUrl } from '../../playwright.config';

// The e2e backend sends E-utilities requests to the fixture server (tests/fixtures/pubmed):
// every search lists the same three PLoS Pathog articles (12,686 matches); a term with "zzqx" matches nothing.
const JOURNAL = 'https://pubmed.ncbi.nlm.nih.gov/rss/journals/101238921/?limit=15&name=PLoS%20Pathog&utm_campaign=journals';
const BUILT = '((cryo-EM[Title/Abstract]) AND (ShanghaiTech[Affiliation])) AND (hasabstract)';
const searches = async (request: import('@playwright/test').APIRequestContext) => (await (await request.get(`${fixtureBaseUrl}/entrez/searches`)).json()) as string[];

test('PubMed 检索订阅：构建条件 → 预览 → 保存 → 刷新 → 查看条目', async ({ page }) => {
  const auth = await loginAsAdmin(page.request), headers = protocolHeaders(auth.csrfToken);
  let feedId: string | undefined;
  try {
    await page.goto('/');
    await page.getByRole('button', { name: '新建订阅', exact: true }).click();
    await page.getByRole('button', { name: 'PubMed 检索', exact: true }).click();
    await expect(page.getByRole('heading', { name: '订阅 PubMed 检索' })).toBeVisible();

    await page.getByLabel('条件 1 的字段').selectOption('tiab');
    // Typing character by character: the preview waits for a pause instead of asking NCBI for every key.
    const before = (await searches(page.request)).length;
    await page.getByLabel('条件 1 的检索词').pressSequentially('cryo-EM', { delay: 40 });
    await page.getByRole('button', { name: '添加条件' }).click();
    await page.getByLabel('条件 2 的字段').selectOption('affiliation');
    await page.getByLabel('条件 2 的检索词').pressSequentially('ShanghaiTech', { delay: 40 });
    await page.getByLabel('只看有摘要的文章').check();
    const query = page.getByLabel('PubMed 查询式');
    await expect(query).toHaveValue(BUILT);
    await expect(page.getByLabel('订阅名称')).toHaveValue('PubMed：cryo-EM · ShanghaiTech');
    await expect(page.getByRole('link', { name: '在 PubMed 中打开' }).first()).toHaveAttribute('href', `https://pubmed.ncbi.nlm.nih.gov/?${new URLSearchParams({ term: BUILT, sort: 'date', size: '20' })}`);

    const preview = page.getByRole('region', { name: '预览' });
    await expect(preview.getByTestId('pubmed-count')).toContainText('12,686');
    await expect(preview.getByRole('link', { name: 'A Fixture virus and CD4+ T cells' })).toHaveAttribute('href', 'https://pubmed.ncbi.nlm.nih.gov/42883926/');
    await expect(preview).toContainText('PLoS Pathog · 2026 Oct 6');
    await expect(preview).toContainText('One A, Two B, Three C 等');
    // What PubMed actually ran is shown, so automatic term mapping is visible.
    await expect(preview.getByTestId('pubmed-translation')).toContainText('"plos pathog"[Journal]');
    // "Exact phrase" quotes one term (and turns term mapping off for it); it is off by default.
    await page.getByLabel('条件 1 作为精确短语').check();
    await expect(query).toHaveValue(BUILT.replace('(cryo-EM[Title/Abstract])', '("cryo-EM"[Title/Abstract])'));
    await page.getByLabel('条件 1 作为精确短语').uncheck();
    await expect(query).toHaveValue(BUILT);
    const sent = (await searches(page.request)).slice(before).filter(term => term === BUILT || !term.includes('"cryo-EM"'));
    expect(sent.at(-1)).toBe(BUILT);
    expect(sent.length, `previews sent while typing: ${JSON.stringify(sent)}`).toBeLessThanOrEqual(3);

    // A query the builder cannot show switches to manual editing; discarding returns to the builder.
    await query.fill('cryo-EM AND (ShanghaiTech OR Fudan)');
    await expect(page.getByRole('status').filter({ hasText: '已切换为手动编辑' })).toBeVisible();
    await expect(page.getByLabel('条件 1 的检索词')).toBeDisabled();
    await page.getByRole('button', { name: '放弃手动修改' }).click();
    await expect(query).toHaveValue(BUILT);
    // An unbalanced query is pointed out and never sent.
    await query.fill('("cryo-EM"[Title/Abstract]');
    await expect(page.getByRole('alert').filter({ hasText: '括号不配对' })).toBeVisible();
    await expect(page.getByRole('button', { name: '保存 PubMed 检索订阅' })).toBeDisabled();
    // Typing a builder-shaped query fills the builder back in.
    await query.fill(BUILT);
    await expect(page.getByLabel('条件 2 的检索词')).toHaveValue('ShanghaiTech');
    await expect(page.getByLabel('只看有摘要的文章')).toBeChecked();

    await page.getByLabel('输出模式').selectOption('bilingual');
    await page.getByLabel('每次抓取最新文章数').selectOption('50');
    const created = page.waitForResponse(response => response.url().endsWith('/api/feeds') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '保存 PubMed 检索订阅' }).click();
    const body = await (await created).json();
    feedId = body.feed.id;
    expect(body.feed.pubmed).toEqual({ query: BUILT, limit: 50 });

    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('.pubmed-source')).toContainText(BUILT);
    await expect(dialog.locator('article.preview-item').filter({ hasText: '中文：A Fixture virus and CD4+ T cells' })).toBeVisible();
    await dialog.getByRole('button', { name: '立即刷新' }).click();
    await expect(page.getByRole('status').filter({ hasText: '刷新完成' })).toBeVisible();
    await expect(dialog.locator('article.preview-item')).toHaveCount(3);

    // Editing goes back to the same builder.
    await dialog.getByRole('button', { name: '订阅设置' }).click();
    await dialog.getByRole('button', { name: '编辑检索条件' }).click();
    await expect(page.getByRole('heading', { name: '编辑 PubMed 检索订阅' })).toBeVisible();
    await expect(page.getByLabel('条件 1 的检索词')).toHaveValue('cryo-EM');
    await expect(page.getByLabel('每次抓取最新文章数')).toHaveValue('50');
  } finally { if (feedId) await page.request.delete(`/api/feeds/${feedId}`, { headers }); }
});

test('期刊 RSS 订阅一键转换为 PubMed 检索订阅：确认后保留订阅 ID 和 RSS 地址', async ({ page }) => {
  const auth = await loginAsAdmin(page.request), headers = protocolHeaders(auth.csrfToken);
  // An existing journal RSS subscription (paused, so nothing reaches the real PubMed site).
  const imported = await page.request.post('/api/backups/config', { headers, data: { confirm: true, archive: { format: 'feedlantern-config', version: 1, feeds: [{ sourceType: 'rss', name: 'PLoS Pathog RSS', url: JOURNAL, rules: { item: '', title: '', link: '' }, intervalMinutes: 60, waitMs: 0, translationMode: 'original', enabled: false }] } } });
  expect(imported.status(), await imported.text()).toBe(200);
  const feed = ((await (await page.request.get('/api/feeds')).json()) as Array<{ id: string; name: string }>).find(entry => entry.name === 'PLoS Pathog RSS')!;
  try {
    const before = await (await page.request.get(`/api/feeds/${feed.id}`)).json();
    await page.goto(`/#/feed/${feed.id}`);
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByTestId('pubmed-rss-notice')).toContainText('NCBI 目前会用验证页拦截程序读取期刊 RSS');
    await dialog.getByRole('button', { name: '转换为 PubMed 检索订阅' }).click();

    await expect(page.getByRole('heading', { name: '转换为 PubMed 检索订阅' })).toBeVisible();
    await expect(page.getByTestId('pubmed-convert-note')).toContainText('PLoS Pathog (NLM ID 101238921)');
    // NCBI blocks the journal RSS and nothing is stored yet, so the prefill is marked for review.
    await expect(page.getByTestId('pubmed-convert-note')).toContainText('未能确认与原 RSS 一致，请核对：没有可对比的条目');
    await expect(page.getByLabel('条件 1 的字段')).toHaveValue('journal');
    await expect(page.getByLabel('PubMed 查询式')).toHaveValue('(PLoS Pathog[Journal])');
    await expect(page.getByLabel('订阅名称')).toHaveValue('PLoS Pathog RSS');
    await expect(page.getByTestId('pubmed-count')).toContainText('12,686');

    // Nothing is converted without the user's confirmation.
    page.once('dialog', prompt => void prompt.dismiss());
    await page.getByRole('button', { name: '确认转换' }).click();
    expect((await (await page.request.get(`/api/feeds/${feed.id}`)).json()).feed.sourceType).toBe('rss');
    page.once('dialog', prompt => { expect(prompt.message()).toContain('已存条目和译文都会保留'); void prompt.accept(); });
    const saved = page.waitForResponse(response => response.url().endsWith(`/api/feeds/${feed.id}`) && response.request().method() === 'PUT');
    await page.getByRole('button', { name: '确认转换' }).click();
    const converted = await (await saved).json();
    expect(converted.feed.id).toBe(feed.id);
    expect(converted.feed.sourceType).toBe('pubmed');
    expect(converted.feedUrl).toBe(before.feedUrl);
    await expect(page.getByRole('dialog').locator('.pubmed-source')).toContainText('PLoS Pathog[Journal]');
    await expect(page.getByRole('dialog').getByTestId('pubmed-rss-notice')).toHaveCount(0);

    // Resuming fetches through E-utilities into the same feed.
    await page.request.post(`/api/feeds/${feed.id}/toggle`, { headers, data: {} });
    const detail = await (await page.request.get(`/api/feeds/${feed.id}`)).json();
    expect(detail.items.map((item: { link: string }) => item.link).sort()).toEqual(['41714066', '42883926', '42900001'].map(id => `https://pubmed.ncbi.nlm.nih.gov/${id}/`));
  } finally { await page.request.delete(`/api/feeds/${feed.id}`, { headers }); }
});

test('来源返回反爬验证页时，预览给出准确报错而不是“实体声明”', async ({ page }) => {
  await loginAsAdmin(page.request);
  await page.goto('/');
  await page.getByRole('button', { name: '新建订阅', exact: true }).click();
  await page.getByRole('button', { name: 'RSS 翻译', exact: true }).click();
  await page.getByLabel('RSS / Atom 地址').fill(`${fixtureBaseUrl}/challenge-feed.xml`);
  await expect(page.getByTestId('pubmed-rss-hint')).toHaveCount(0);
  await page.getByRole('button', { name: '预览订阅源' }).click();
  const alert = page.getByRole('alert').filter({ hasText: '反爬验证页' });
  await expect(alert).toContainText('（HTTP 203，页面含 cookies-required 标记）');
  await expect(alert).toContainText('FeedLantern 不会尝试绕过');
  await expect(alert).not.toContainText('实体声明');

  // A PubMed journal RSS address is explained up front, with a way to build the search instead (never automatic).
  await page.getByLabel('RSS / Atom 地址').fill(JOURNAL);
  await expect(page.getByTestId('pubmed-rss-hint')).toContainText('NCBI 会拦截程序访问');
  await page.getByRole('button', { name: '改用 PubMed 检索订阅' }).click();
  await expect(page.getByLabel('PubMed 查询式')).toHaveValue('(PLoS Pathog[Journal])');
  await expect(page.getByRole('button', { name: 'PubMed 检索', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('管理员在“设置 → PubMed（NCBI）”填写 API Key 和联系邮箱，Key 不回显', async ({ page }) => {
  const auth = await loginAsAdmin(page.request), headers = protocolHeaders(auth.csrfToken);
  try {
    await page.goto('/#/settings/pubmed');
    const form = page.getByRole('form', { name: 'PubMed（NCBI）' });
    await form.getByLabel('NCBI API Key（可选）').fill('e2ekey0123456789');
    await form.getByLabel('联系邮箱（可选）').fill('admin@example.test');
    // The typed values can be tested before saving (the fixture answers like NCBI does for a working key).
    await expect(form.getByTestId('ncbi-test')).toContainText('Key 已修改，保存前请先测试');
    await form.getByRole('button', { name: '测试', exact: true }).click();
    await expect(form.getByTestId('ncbi-test').getByRole('status')).toHaveText('Key 有效：NCBI 允许每秒 10 个请求。');
    const sent = page.waitForRequest(request => request.url().endsWith('/api/settings') && request.method() === 'PUT');
    await form.getByRole('button', { name: '保存 PubMed 设置' }).click();
    expect((await sent).postDataJSON()).toEqual({ ncbi: { email: 'admin@example.test', apiKey: 'e2ekey0123456789' } });
    await expect(form.getByRole('status')).toContainText('设置已保存');
    await page.reload();
    await expect(form.getByLabel('NCBI API Key（可选）')).toHaveValue('');
    await expect(form.getByLabel('NCBI API Key（可选）')).toHaveAttribute('placeholder', '已保存，留空保持不变');
    await expect(form.getByLabel('联系邮箱（可选）')).toHaveValue('admin@example.test');
    await expect(form.getByTestId('ncbi-test')).toContainText('已配置 Key。上次测试：Key 有效：NCBI 允许每秒 10 个请求。');
    expect(await (await page.request.get('/api/settings')).text()).not.toContain('e2ekey0123456789');
    await form.getByLabel('保存时删除已保存的 Key').check();
    await form.getByRole('button', { name: '保存 PubMed 设置' }).click();
    await expect(form.getByLabel('保存时删除已保存的 Key')).toHaveCount(0);
  } finally { await page.request.put('/api/settings', { headers, data: { ncbi: { apiKey: null, email: '' } } }); }
});

// Search RSS feeds whose RSS the backend reads from the fixture server (title = query).
const SEARCH_RSS = (id: string) => `https://pubmed.ncbi.nlm.nih.gov/rss/search/${id}/?limit=15&utm_campaign=pubmed-2`;
async function importRss(request: import('@playwright/test').APIRequestContext, headers: Record<string, string>, feeds: Array<{ name: string; url: string }>) {
  const response = await request.post('/api/backups/config', { headers, data: { confirm: true, archive: { format: 'feedlantern-config', version: 1, feeds: feeds.map(feed => ({ sourceType: 'rss', ...feed, rules: { item: '', title: '', link: '' }, intervalMinutes: 60, waitMs: 0, translationMode: 'original', enabled: false })) } } });
  expect(response.status(), await response.text()).toBe(200);
  const all = (await (await request.get('/api/feeds')).json()) as Array<{ id: string; name: string }>;
  return feeds.map(feed => all.find(entry => entry.name === feed.name)!.id);
}

test('检索式 RSS 订阅：验证还原的查询式后确认转换', async ({ page }) => {
  const auth = await loginAsAdmin(page.request), headers = protocolHeaders(auth.csrfToken);
  const [id] = await importRss(page.request, headers, [{ name: 'Wolbachia in PLoS Pathog', url: SEARCH_RSS('e2eok') }]);
  try {
    const before = await (await page.request.get(`/api/feeds/${id}`)).json();
    await page.goto(`/#/feed/${id}`);
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByTestId('pubmed-rss-notice')).toContainText('不会被网页验证拦截');
    await dialog.getByRole('button', { name: '转换为 PubMed 检索订阅' }).click();
    const result = dialog.getByTestId('pubmed-check-result');
    await expect(result).toContainText('可直接转换');
    await expect(result).toContainText('2/2（100%）');
    await expect(result.locator('code')).toHaveText('("PLoS Pathog"[Journal]) AND (Wolbachia[tiab])');
    await result.getByRole('button', { name: '确认转换' }).click();
    await expect(page.getByRole('status').filter({ hasText: '已转换为 PubMed 检索订阅' })).toBeVisible();
    await expect(dialog.locator('.pubmed-source')).toContainText('(Wolbachia[tiab])');
    const after = await (await page.request.get(`/api/feeds/${id}`)).json();
    expect([after.feed.id, after.feedUrl, after.feed.sourceType]).toEqual([id, before.feedUrl, 'pubmed']);
  } finally { await page.request.delete(`/api/feeds/${id}`, { headers }); }
});

test('批量转换 PubMed RSS 订阅：逐个验证并汇总，确认后只转换可直接转换的，需要核对的逐个打开构建器', async ({ page }) => {
  const auth = await loginAsAdmin(page.request), headers = protocolHeaders(auth.csrfToken);
  const ids = await importRss(page.request, headers, [{ name: 'Batch OK', url: SEARCH_RSS('e2eok') }, { name: 'Batch Low', url: SEARCH_RSS('e2elow') }]);
  try {
    await page.goto('/');
    const strip = page.getByTestId('pubmed-batch-strip');
    await expect(strip).toContainText('有 2 个 PubMed RSS 订阅可以转换');
    await strip.getByRole('button', { name: '验证并转换' }).click();
    const modal = page.getByRole('dialog', { name: '转换 PubMed RSS 订阅' });
    await expect(modal.getByRole('status')).toContainText('共 2 个：1 个可直接转换，1 个需要核对。');
    await expect(modal).toContainText('未配置 NCBI API Key');
    const ok = modal.getByRole('row').filter({ hasText: 'Batch OK' });
    const low = modal.getByRole('row').filter({ hasText: 'Batch Low' });
    await expect(ok).toContainText('可直接转换');
    await expect(low).toContainText('需要核对：订阅的最新条目与查询结果吻合太少');
    await expect(low.locator('code')).toHaveText('(lantern[ti]) AND (fungi[ti])');
    page.once('dialog', prompt => { expect(prompt.message()).toContain('1 个订阅'); void prompt.accept(); });
    await modal.getByRole('button', { name: '转换 1 个可直接转换的订阅' }).click();
    await expect(ok).toContainText('已转换');
    expect((await (await page.request.get(`/api/feeds/${ids[0]}`)).json()).feed.sourceType).toBe('pubmed');
    expect((await (await page.request.get(`/api/feeds/${ids[1]}`)).json()).feed.sourceType).toBe('rss');

    await low.getByRole('button', { name: '核对' }).click();
    await expect(page.getByRole('heading', { name: '转换为 PubMed 检索订阅' })).toBeVisible();
    await expect(page.getByTestId('pubmed-convert-note')).toContainText('未能确认与原 RSS 一致，请核对');
    await expect(page.getByTestId('pubmed-convert-note')).toContainText('(lantern[ti]) AND (fungi[ti]');
    await expect(page.getByLabel('PubMed 查询式')).toHaveValue('(lantern[ti]) AND (fungi[ti])');
  } finally { for (const id of ids) await page.request.delete(`/api/feeds/${id}`, { headers }); }
});
