/** The form of an item link used to recognise the same item again. */
export function normalizeLink(link: string, baseUrl?: string): string {
  const raw = link.trim();
  try {
    const parsed = new URL(raw, baseUrl);
    parsed.hash = '';
    parsed.hostname = parsed.hostname.toLowerCase();
    if ((parsed.protocol === 'http:' && parsed.port === '80') || (parsed.protocol === 'https:' && parsed.port === '443')) parsed.port = '';
    return parsed.toString();
  } catch {
    return raw.replace(/#.*$/, '');
  }
}
