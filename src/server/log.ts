// Server logs keep the full error text so failures can be diagnosed, minus
// URL query strings and anything that looks like a credential.
export function redactForLog(text: string): string {
  return text
    // user:password@ in any URL, including socks5:// proxy addresses.
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@"'<>]+@/gi, '$1[hidden]@')
    .replace(/(https?:\/\/[^\s?#"'<>)]+)[?#][^\s"'<>)]*/gi, '$1?[hidden]')
    .replace(/(?:cookie|authorization|set-cookie|token|password)\s*["']?\s*[:=][^\n]*/gi, '[sensitive data hidden]')
    .replace(/Bearer\s+\S+/gi, '[sensitive data hidden]')
    .slice(0, 4000);
}
