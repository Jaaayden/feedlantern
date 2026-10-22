// Small display and file helpers shared by the web UI.

const absoluteFormat = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

export function absoluteTime(value?: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : absoluteFormat.format(date);
}

/** "刚刚 / 3 分钟前 / 2 小时后 / 昨天 / 10月3日" style labels. */
export function relativeTime(value?: string | null, now = Date.now()): string {
  if (!value) return '';
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return '';
  const diff = time - now, future = diff > 0, abs = Math.abs(diff);
  const minute = 60_000, hour = 60 * minute, day = 24 * hour;
  const suffix = future ? '后' : '前';
  if (abs < 45_000) return future ? '即将' : '刚刚';
  if (abs < hour) return `${Math.round(abs / minute)} 分钟${suffix}`;
  if (abs < day) return `${Math.round(abs / hour)} 小时${suffix}`;
  if (abs < 2 * day && !future) return '昨天';
  if (abs < 7 * day) return `${Math.round(abs / day)} 天${suffix}`;
  const date = new Date(time), current = new Date(now);
  return date.getFullYear() === current.getFullYear() ? `${date.getMonth() + 1}月${date.getDate()}日` : `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!);
}

export function buildOpml(title: string, feeds: Array<{ name: string; feedUrl: string; siteUrl: string }>): string {
  const outlines = feeds.map(feed => `    <outline type="rss" text="${escapeXml(feed.name)}" title="${escapeXml(feed.name)}" xmlUrl="${escapeXml(feed.feedUrl)}" htmlUrl="${escapeXml(feed.siteUrl)}"/>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head>\n    <title>${escapeXml(title)}</title>\n    <dateCreated>${new Date().toUTCString()}</dateCreated>\n  </head>\n  <body>\n${outlines}\n  </body>\n</opml>\n`;
}

/** Pull every feed URL out of an OPML document (nested folders included). */
export function parseOpmlUrls(text: string): string[] {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('不是有效的 OPML 文件');
  const urls = Array.from(doc.querySelectorAll('outline[xmlUrl], outline[xmlurl]'))
    .map(node => (node.getAttribute('xmlUrl') ?? node.getAttribute('xmlurl') ?? '').trim())
    .filter(Boolean);
  return [...new Set(urls)];
}

export function downloadText(text: string, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const avatarHues = [148, 92, 38, 200, 262, 18, 330, 172];
export function avatarHue(name: string): number {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return avatarHues[hash % avatarHues.length];
}

export function initial(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const first = [...trimmed][0];
  return /[a-z]/i.test(first) ? first.toUpperCase() : first;
}

/**
 * Copy text even on plain-http deployments (http://server-ip:4321), where
 * browsers do not expose navigator.clipboard outside secure contexts.
 */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return; } catch { /* fall back below */ }
  }
  const previous = document.activeElement as HTMLElement | null;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  Object.assign(area.style, { position: 'fixed', top: '0', left: '0', width: '1px', height: '1px', opacity: '0' });
  document.body.appendChild(area);
  area.select();
  area.setSelectionRange(0, text.length);
  let copied = false;
  try { copied = document.execCommand('copy'); } finally { area.remove(); previous?.focus(); }
  if (!copied) throw new Error('无法访问剪贴板');
}

/** Readable text for summaries that may contain HTML (RSS descriptions). DOMParser never runs scripts. */
export function summaryText(value: string): string {
  if (!/[<&]/.test(value)) return value;
  const text = new DOMParser().parseFromString(value, 'text/html').body.textContent ?? '';
  return text.replace(/\s+/g, ' ').trim();
}

/** Compare addresses loosely: ignore fragments, a trailing slash and host case. */
export function sameAddress(a: string, b: string): boolean {
  const normal = (value: string) => {
    try { const url = new URL(value.trim()); url.hash = ''; return url.href.replace(/\/$/, ''); } catch { return value.trim().replace(/\/$/, ''); }
  };
  return !!a.trim() && normal(a) === normal(b);
}
