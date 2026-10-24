import { test, expect } from './fixtures';
import { loginAsAdmin, protocolHeaders } from './support';
import { fixtureBaseUrl } from '../../playwright.config';

// The e2e backend sends E-utilities requests to the fixture server (tests/fixtures/pubmed):
// every search lists the same three PLoS Pathog articles (12,686 matches); a term with "zzqx" matches nothing.
const JOURNAL = 'https://pubmed.ncbi.nlm.nih.gov/rss/journals/101238921/?limit=15&name=PLoS%20Pathog&utm_campaign=journals';
const BUILT = '(("cryo-EM"[Title/Abstract]) AND ("ShanghaiTech"[Affiliation])) AND (hasabstract)';
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
    const sent = (await searches(page.request)).slice(before);
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
    await expect(page.getByLabel('条件 1 的字段')).toHaveValue('journal');
    await expect(page.getByLabel('PubMed 查询式')).toHaveValue('("PLoS Pathog"[Journal])');
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
    await expect(page.getByRole('dialog').locator('.pubmed-source')).toContainText('"PLoS Pathog"[Journal]');
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
  await expect(page.getByLabel('PubMed 查询式')).toHaveValue('("PLoS Pathog"[Journal])');
  await expect(page.getByRole('button', { name: 'PubMed 检索', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('管理员在“设置 → PubMed（NCBI）”填写 API Key 和联系邮箱，Key 不回显', async ({ page }) => {
  const auth = await loginAsAdmin(page.request), headers = protocolHeaders(auth.csrfToken);
  try {
    await page.goto('/#/settings/pubmed');
    const form = page.getByRole('form', { name: 'PubMed（NCBI）' });
    await form.getByLabel('NCBI API Key（可选）').fill('e2ekey0123456789');
    await form.getByLabel('联系邮箱（可选）').fill('admin@example.test');
    const sent = page.waitForRequest(request => request.url().endsWith('/api/settings') && request.method() === 'PUT');
    await form.getByRole('button', { name: '保存 PubMed 设置' }).click();
    expect((await sent).postDataJSON()).toEqual({ ncbi: { email: 'admin@example.test', apiKey: 'e2ekey0123456789' } });
    await expect(form.getByRole('status')).toContainText('设置已保存');
    await page.reload();
    await expect(form.getByLabel('NCBI API Key（可选）')).toHaveValue('');
    await expect(form.getByLabel('NCBI API Key（可选）')).toHaveAttribute('placeholder', '已保存，留空保持不变');
    await expect(form.getByLabel('联系邮箱（可选）')).toHaveValue('admin@example.test');
    expect(await (await page.request.get('/api/settings')).text()).not.toContain('e2ekey0123456789');
    await form.getByLabel('保存时删除已保存的 Key').check();
    await form.getByRole('button', { name: '保存 PubMed 设置' }).click();
    await expect(form.getByLabel('保存时删除已保存的 Key')).toHaveCount(0);
  } finally { await page.request.put('/api/settings', { headers, data: { ncbi: { apiKey: null, email: '' } } }); }
});
