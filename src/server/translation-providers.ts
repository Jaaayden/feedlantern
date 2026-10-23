import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { parseDocument } from 'htmlparser2';
import { NetworkPolicy, NetworkPolicyError } from './network.js';
import { digest } from './rss-source.js';
import { translationProviderLabels, type ApplicationSettings, type TargetLanguage, type TranslationProviderId, type TranslationRate } from '../shared/types.js';

export type TranslationSettings = ApplicationSettings['translation'];

export class TranslationError extends Error {
  constructor(message: string, public retryAfterMs = 0, public rateLimited = false) { super(message); }
}

/**
 * One translation service for one target language. The worker owns queueing,
 * caching, rate limits and retries; an engine only turns texts into
 * translations, one result per input in the same order, or throws.
 */
export interface TranslationEngine {
  provider: TranslationProviderId;
  label: string;
  /** Cache namespace: translations from different services or languages never share a key. */
  namespace: string;
  /** Most texts and characters one request may carry. */
  batch: { segments: number; characters: number };
  /** Set when the service cannot run yet (for example a missing API key). */
  unavailable?: string;
  translate(texts: string[], signal: AbortSignal): Promise<string[]>;
}

export function providerRate(settings: TranslationSettings, provider: TranslationProviderId): TranslationRate {
  const source = provider === 'google' ? settings : settings[provider];
  return { concurrency: source.concurrency, requestIntervalMs: source.requestIntervalMs };
}

/** Why a service cannot be used yet, or undefined when it is ready. */
export function providerProblem(settings: TranslationSettings, provider: TranslationProviderId): string | undefined {
  if (provider === 'deepl' && !settings.deepl.apiKey) return 'DeepL 尚未配置 API Key，请管理员在“设置 → 翻译服务”中填写';
  if (provider === 'openai' && (!settings.openai.baseUrl || !settings.openai.model)) return 'OpenAI 兼容接口尚未配置接口地址和模型，请管理员在“设置 → 翻译服务”中填写';
  return undefined;
}

export function retryAfterMs(value: string | null | undefined): number {
  if (!value) return 0;
  const ms = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.max(0, Math.min(ms, 86400_000)) : 0;
}

/** Translations keep the source's surrounding whitespace, which services often trim. */
export function keepWhitespace(source: string, translated: string): string {
  return (source.match(/^\s*/)?.[0] ?? '') + translated.trim() + (source.match(/\s*$/)?.[0] ?? '');
}

interface PostResult { status: number; headers: IncomingHttpHeaders; body: string }

/**
 * POST through the outbound network policy: the target is resolved and
 * checked first and the connection is pinned to that address, so a public
 * hostname cannot be rebound to a private one. Private and loopback hosts
 * (for example a local Ollama) only work when the administrator allow-lists
 * their exact host:port. Redirects are not followed.
 */
export async function policyPost(raw: string, policy: NetworkPolicy, headers: Record<string, string>, body: string, signal: AbortSignal, maxBytes: number): Promise<PostResult> {
  const { url, address } = await Promise.race([
    policy.resolveForConnection(raw),
    new Promise<never>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  ]);
  signal.throwIfAborted();
  return new Promise<PostResult>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'POST', signal, agent: false, family: isIP(address),
      headers: { 'content-type': 'application/json', accept: 'application/json', 'accept-encoding': 'identity', 'user-agent': 'FeedLantern translation', 'content-length': String(Buffer.byteLength(body)), ...headers },
      lookup: (_host, _options, callback) => callback(null, address, isIP(address)),
    }, response => {
      const chunks: Buffer[] = []; let size = 0;
      response.on('error', reject);
      response.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) { response.destroy(new TranslationError('翻译服务响应过大')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

async function post(label: string, endpoint: string, policy: NetworkPolicy, headers: Record<string, string>, body: unknown, signal: AbortSignal, timeoutMs: number, maxBytes: number): Promise<PostResult> {
  const combined = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  try {
    return await policyPost(endpoint, policy, headers, JSON.stringify(body), combined, maxBytes);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof TranslationError) throw error;
    // Policy messages name only the host; other socket errors may carry details we do not show.
    if (error instanceof NetworkPolicyError) throw new TranslationError(`${label}：${error.message}`);
    throw new TranslationError(combined.aborted ? `${label} 响应超时，请稍后重试` : `${label} 连接失败，请检查接口地址和服务主机网络`);
  }
}

function json(label: string, text: string): unknown {
  try { return JSON.parse(text); } catch { throw new TranslationError(`${label} 返回了无法识别的内容`); }
}

function httpFailure(label: string, response: PostResult, hints: Partial<Record<number, string>> = {}): TranslationError {
  const retryMs = retryAfterMs(typeof response.headers['retry-after'] === 'string' ? response.headers['retry-after'] : undefined);
  if (response.status === 429) return new TranslationError(`${label} 请求受限（HTTP 429），稍后自动重试`, retryMs, true);
  return new TranslationError(hints[response.status] ?? `${label} 服务暂不可用（HTTP ${response.status}）`, retryMs);
}

const deeplTargets: Record<TargetLanguage, string> = { 'zh-CN': 'ZH-HANS', 'zh-TW': 'ZH-HANT', en: 'EN-US', ja: 'JA', ko: 'KO' };
export const deeplEndpoints = { free: 'https://api-free.deepl.com/v2/translate', pro: 'https://api.deepl.com/v2/translate' };

/** DeepL's official API; free-plan keys end with `:fx` and use their own host. */
export function deeplEngine(target: TargetLanguage, settings: TranslationSettings['deepl'], policy: () => NetworkPolicy, endpoints = deeplEndpoints): TranslationEngine {
  const label = 'DeepL';
  const plan = settings.plan === 'auto' ? (settings.apiKey.endsWith(':fx') ? 'free' : 'pro') : settings.plan;
  return {
    provider: 'deepl', label, namespace: `deepl:v1:${target}`, batch: { segments: 50, characters: 6000 },
    async translate(texts, signal) {
      const response = await post(label, endpoints[plan], policy(), { authorization: `DeepL-Auth-Key ${settings.apiKey}` }, { text: texts, target_lang: deeplTargets[target] }, signal, 30_000, 2_000_000);
      if (response.status === 456) throw new TranslationError('DeepL 本月字符额度已用完（HTTP 456），请检查账户后重试', 3600_000, true);
      if (response.status !== 200) throw httpFailure(label, response, {
        403: `DeepL 拒绝访问（HTTP 403），请检查 API Key 和${settings.plan === 'auto' ? '' : '所选'}套餐类型`,
        413: 'DeepL 拒绝了过大的请求（HTTP 413）',
      });
      const body = json(label, response.body) as { translations?: Array<{ text?: unknown }> };
      const results = Array.isArray(body?.translations) ? body.translations.map(row => row?.text) : [];
      if (results.length !== texts.length || !results.every((value): value is string => typeof value === 'string' && !!value.trim())) {
        throw new TranslationError('DeepL 译文数量或格式不匹配，整批未发布');
      }
      return results.map((text, i) => keepWhitespace(texts[i], text));
    },
  };
}

const languageNames: Record<TargetLanguage, string> = { 'zh-CN': 'Simplified Chinese', 'zh-TW': 'Traditional Chinese', en: 'English', ja: 'Japanese', ko: 'Korean' };
export const defaultSystemPrompt = 'You are a professional translator for a news and blog reader. Translate naturally and accurately, keeping names, numbers and the original meaning.';

/** The reply format is fixed after any custom prompt, so a prompt cannot change what we parse. */
export function openaiSystemPrompt(target: TargetLanguage, custom: string): string {
  return [custom.trim() || defaultSystemPrompt, '',
    `Translate every segment into ${languageNames[target]}.`,
    'The user message contains numbered segments, each written as <seg id="N">text</seg>. They are consecutive pieces of one article, given in reading order.',
    'Reply with exactly the same segments, in the same order and with the same ids, each containing only the translation of that segment.',
    'Rules: never merge, split, drop or add segments; output nothing outside the segments (no explanations, no Markdown); do not add any other HTML tags;',
    'keep the entities &lt; &gt; &amp; as they are; leave code, commands, URLs, file paths, identifiers and placeholders unchanged.',
  ].join('\n');
}

const escapeText = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** Parse `<seg id="N">…</seg>` replies. Any segment count, order or tag mismatch is a failure, never a partial result. */
export function parseSegments(content: string, texts: string[], label = 'OpenAI 兼容接口'): string[] {
  const reply = content.replace(/^\s*<think>[\s\S]*?<\/think>/, '').trim().replace(/^```[a-z]*\n?([\s\S]*?)\n?```$/i, '$1');
  const pattern = /<seg\s+id=["']?(\d+)["']?\s*>([\s\S]*?)<\/seg\s*>/gi;
  const outputs: string[] = [];
  let last = 0;
  for (const match of reply.matchAll(pattern)) {
    if (reply.slice(last, match.index).trim()) throw new TranslationError(`${label} 返回了分段以外的内容，整批未发布`);
    if (Number(match[1]) !== outputs.length + 1 || /<\/?seg\b/i.test(match[2])) throw new TranslationError(`${label} 返回的分段编号或标签不匹配，整批未发布`);
    const document = parseDocument(match[2]);
    // Sources are plain text, so any tag inside a translation means the reply is malformed.
    if (document.children.some(function hasTag(node): boolean { return node.type === 'tag' || node.type === 'script' || node.type === 'style' || ('children' in node && node.children.some(hasTag)); })) {
      throw new TranslationError(`${label} 译文中出现了原文没有的标签，整批未发布`);
    }
    const parts: string[] = [];
    const collect = (node: (typeof document.children)[number]): void => { if (node.type === 'text') parts.push(node.data); else if ('children' in node) node.children.forEach(collect); };
    document.children.forEach(collect);
    outputs.push(parts.join(''));
    last = match.index + match[0].length;
  }
  if (reply.slice(last).trim()) throw new TranslationError(`${label} 返回了分段以外的内容，整批未发布`);
  if (outputs.length !== texts.length) throw new TranslationError(`${label} 返回的分段数量不匹配（${outputs.length}/${texts.length}），整批未发布`);
  return outputs.map((text, i) => {
    if (!text.trim() && texts[i].trim()) throw new TranslationError(`${label} 返回了空译文`);
    return keepWhitespace(texts[i], text);
  });
}

/** Any service with an OpenAI-style `/chat/completions` endpoint (OpenAI, DeepSeek, Ollama, vLLM, …). */
export function openaiEngine(target: TargetLanguage, settings: TranslationSettings['openai'], policy: () => NetworkPolicy): TranslationEngine {
  const label = 'OpenAI 兼容接口';
  const fingerprint = digest(`${settings.baseUrl}\n${settings.model}\n${settings.systemPrompt}`).slice(0, 16);
  return {
    provider: 'openai', label, namespace: `openai:v1:${fingerprint}:${target}`, batch: { segments: 40, characters: 4000 },
    async translate(texts, signal) {
      const response = await post(label, `${settings.baseUrl}/chat/completions`, policy(), settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {}, {
        model: settings.model, stream: false,
        messages: [
          { role: 'system', content: openaiSystemPrompt(target, settings.systemPrompt) },
          { role: 'user', content: texts.map((text, i) => `<seg id="${i + 1}">${escapeText(text)}</seg>`).join('\n') },
        ],
      }, signal, 180_000, 4_000_000);
      if (response.status !== 200) throw httpFailure(label, response, {
        401: `${label} 拒绝访问（HTTP 401），请检查 API Key`,
        403: `${label} 拒绝访问（HTTP 403），请检查 API Key 和模型权限`,
        404: `${label} 找不到接口或模型（HTTP 404），请检查接口地址和模型名称`,
      });
      const body = json(label, response.body) as { choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }> };
      const choice = Array.isArray(body?.choices) ? body.choices[0] : undefined;
      if (typeof choice?.message?.content !== 'string') throw new TranslationError(`${label} 返回了无法识别的内容`);
      if (choice.finish_reason === 'length') throw new TranslationError(`${label} 输出被截断（达到模型长度上限），整批未发布`);
      return parseSegments(choice.message.content, texts, label);
    },
  };
}

export function providerLabel(provider: TranslationProviderId): string { return translationProviderLabels[provider]; }
