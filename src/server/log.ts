// Server logs keep the full error text so failures can be diagnosed, minus
// URL query strings and anything that looks like a credential.
export function redactForLog(text: string): string {
  return text
    .replace(/(https?:\/\/[^\s?#"'<>)]+)[?#][^\s"'<>)]*/gi, '$1?[已隐藏]')
    .replace(/(?:cookie|authorization|set-cookie|token|password)\s*["']?\s*[:=][^\n]*/gi, '[敏感信息已隐藏]')
    .replace(/Bearer\s+\S+/gi, '[敏感信息已隐藏]')
    .slice(0, 4000);
}
