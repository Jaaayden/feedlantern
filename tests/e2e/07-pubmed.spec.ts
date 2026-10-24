import { test, expect } from './fixtures';
import { loginAsAdmin, protocolHeaders } from './support';
import { fixtureBaseUrl } from '../../playwright.config';

// The e2e backend sends E-utilities requests to the fixture server (tests/fixtures/pubmed).
const JOURNAL = 'https://pubmed.ncbi.nlm.nih.gov/rss/journals/101238921/?limit=15&name=PLoS%20Pathog&utm_campaign=journals';

test('粘贴 PubMed 期刊 RSS 地址：通过 E-utilities 预览和保存，面板标出实际抓取方式', async ({ page }) => {
  const auth = await loginAsAdmin(page.request), headers = protocolHeaders(auth.csrfToken);
  let feedId: string | undefined;
  try {
    await page.goto('/');
    await page.getByRole('button', { name: '新建订阅', exact: true }).click();
    await page.getByRole('button', { name: 'RSS 翻译', exact: true }).click();
    await page.getByLabel('RSS / Atom 地址').fill(JOURNAL);
    await expect(page.getByTestId('pubmed-eutils-hint')).toContainText('NCBI 官方的 E-utilities');
    await page.getByRole('button', { name: '预览订阅源' }).click();
    await expect(page.getByLabel('订阅名称')).toHaveValue('PLoS Pathog');
    await expect(page.frameLocator('iframe[title="原文预览 2"]').getByText('BACKGROUND: Fixture viruses use', { exact: false })).toBeVisible();
    const created = page.waitForResponse(response => response.url().endsWith('/api/feeds') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '保存 RSS 翻译订阅' }).click();
    feedId = (await (await created).json()).feed.id;
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('.detail-source')).toContainText('通过 NCBI E-utilities 获取');
    await expect(dialog.getByText('翻译：3 条完成', { exact: false })).toBeVisible();
    await expect(dialog.locator('article.preview-item').filter({ hasText: '中文：A Fixture virus and CD4+ T cells' })).toBeVisible();
  } finally { if (feedId) await page.request.delete(`/api/feeds/${feedId}`, { headers }); }
});

test('来源返回反爬验证页时，预览给出准确报错而不是“实体声明”', async ({ page }) => {
  await loginAsAdmin(page.request);
  await page.goto('/');
  await page.getByRole('button', { name: '新建订阅', exact: true }).click();
  await page.getByRole('button', { name: 'RSS 翻译', exact: true }).click();
  await page.getByLabel('RSS / Atom 地址').fill(`${fixtureBaseUrl}/challenge-feed.xml`);
  await expect(page.getByTestId('pubmed-eutils-hint')).toHaveCount(0);
  await page.getByRole('button', { name: '预览订阅源' }).click();
  const alert = page.getByRole('alert').filter({ hasText: '反爬验证页' });
  await expect(alert).toContainText('（HTTP 203，页面含 cookies-required 标记）');
  await expect(alert).toContainText('FeedLantern 不会尝试绕过');
  await expect(alert).not.toContainText('实体声明');
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
