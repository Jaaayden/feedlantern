import { test, expect } from './fixtures';
import { loginAsAdmin, protocolHeaders } from './support';
import { fixtureBaseUrl } from '../../playwright.config';

test('管理员配置 DeepL 和 OpenAI 兼容接口，订阅选择服务与目标语言', async ({ page }) => {
  const auth = await loginAsAdmin(page.request), headers = protocolHeaders(auth.csrfToken);
  const original = await (await page.request.get('/api/settings')).json();
  try {
    await page.goto('/#/settings/translation');
    const form = page.getByRole('form', { name: '翻译服务' });
    const google = form.getByRole('article', { name: 'Google 免费翻译' }), deepl = form.getByRole('article', { name: 'DeepL' }), openai = form.getByRole('article', { name: 'OpenAI 兼容接口' });
    // The default service is expanded; the others are collapsed cards with their status.
    await expect(google.getByRole('button', { expanded: true })).toBeVisible();
    await expect(google).toContainText('默认');
    await expect(deepl).toContainText('未配置');
    await expect(form.getByLabel('DeepL API Key')).toHaveCount(0);
    await expect(deepl.getByRole('button', { name: '设为默认 DeepL' })).toBeDisabled();
    await openai.getByRole('button', { name: /OpenAI 兼容接口/, expanded: false }).click();
    await form.getByLabel('接口地址（Base URL）').fill(`${fixtureBaseUrl}/openai/v1`);
    await form.getByLabel('模型名称').fill('fixture-model');
    await expect(openai).toContainText('已配置');
    await form.getByLabel('OpenAI 兼容接口 API Key（本地模型可留空）').fill('sk-e2e-secret');
    await form.getByRole('button', { name: '测试 OpenAI 兼容接口' }).click();
    await expect(form.getByRole('status').filter({ hasText: '测试成功' })).toContainText('Simplified Chinese fixture-model：');
    await deepl.getByRole('button', { name: /DeepL/, expanded: false }).click();
    await form.getByLabel('DeepL API Key').fill('e2e-deepl-key:fx');
    await form.getByRole('button', { name: '测试 DeepL' }).click();
    await expect(form.getByRole('status').filter({ hasText: '测试成功' })).toContainText('DeepL ZH-HANS：');
    await deepl.getByRole('button', { name: '设为默认 DeepL' }).click();
    await expect(deepl).toContainText('默认');
    // Only what changed in this group is sent.
    const sent = page.waitForRequest(request => request.url().endsWith('/api/settings') && request.method() === 'PUT');
    await form.getByRole('button', { name: '保存翻译服务' }).click();
    const body = (await sent).postDataJSON();
    expect(Object.keys(body)).toEqual(['translation']);
    expect(body.translation).toEqual({ defaultProvider: 'deepl', deepl: { apiKey: 'e2e-deepl-key:fx' }, openai: { baseUrl: `${fixtureBaseUrl}/openai/v1`, model: 'fixture-model', apiKey: 'sk-e2e-secret' } });
    await expect(form.getByRole('status').filter({ hasText: '设置已保存' })).toBeVisible();
    await page.reload();
    await expect(deepl).toContainText('默认');
    await expect(form.getByLabel('DeepL API Key')).toHaveValue('');
    await expect(form.getByLabel('DeepL API Key')).toHaveAttribute('placeholder', '已保存，留空保持不变');
    await expect(form.getByLabel('接口地址（Base URL）')).toHaveCount(0);
    const saved = await (await page.request.get('/api/settings')).json();
    expect(JSON.stringify(saved)).not.toContain('sk-e2e-secret'); expect(saved.translation.openai.apiKeyConfigured).toBe(true);
    expect(saved.translation.defaultProvider).toBe('deepl');

    await page.goto('/');
    await page.getByRole('button', { name: '新建订阅', exact: true }).click();
    await page.getByRole('button', { name: 'RSS 翻译', exact: true }).click();
    await page.getByLabel('RSS / Atom 地址').fill(`${fixtureBaseUrl}/feed.xml?providers=1`);
    await page.getByRole('button', { name: '预览订阅源' }).click();
    await expect(page.getByLabel('订阅名称')).toHaveValue('RSS translation fixture');
    await page.getByLabel('输出模式').selectOption('translated');
    await page.getByLabel('目标语言').selectOption('ja');
    await page.getByLabel('翻译服务').selectOption('openai');
    await page.getByRole('button', { name: '保存 RSS 翻译订阅' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('翻译：1 条完成', { exact: false })).toBeVisible();
    await expect(dialog.getByRole('link', { name: 'Japanese fixture-model：Hello RSS', exact: false })).toBeVisible();
    await dialog.getByRole('button', { name: '展开全文' }).first().click();
    const frame = dialog.frameLocator('iframe[title="订阅正文 1"]');
    await expect(frame.getByText('const example = 1;', { exact: true })).toBeVisible();
    const rss = await dialog.locator('input[readonly]').inputValue();
    const japanese = await (await page.request.get(rss)).text();
    expect(japanese).toContain('<language>ja</language>'); expect(japanese).toContain('<title>Japanese fixture-model：Hello RSS</title>');
    const guid = japanese.match(/<guid[^>]*>(.*?)<\/guid>/)?.[1];

    await dialog.getByRole('button', { name: '订阅设置', exact: true }).click();
    await dialog.getByLabel('目标语言').selectOption('ko');
    await dialog.getByLabel('翻译服务').selectOption('deepl');
    await expect(dialog.getByText('已有文章会重新翻译', { exact: false })).toBeVisible();
    await dialog.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(dialog.getByRole('button', { name: '保存设置', exact: true })).toBeDisabled();
    await expect.poll(async () => (await (await page.request.get(rss)).text())).toContain('<title>DeepL KO：Hello RSS</title>');
    const korean = await (await page.request.get(rss)).text();
    expect(korean).toContain('<language>ko</language>'); expect(korean).toContain(guid!);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  } finally {
    await page.request.put('/api/settings', { headers, data: { ...original, translation: { ...original.translation, defaultProvider: 'google', deepl: { ...original.translation.deepl, apiKey: null }, openai: { ...original.translation.openai, apiKey: null } } } });
  }
});
