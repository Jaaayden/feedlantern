import pkg from '../package.json' with { type: 'json' };

/** Kept equal to the server version it was released with (see doc/agent.md). */
export const CLI_VERSION: string = pkg.version;

/**
 * 0.x releases may change the API in a minor version, so the CLI expects the
 * same major.minor as the server (from 1.0 on, the same major); patch
 * versions never break compatibility.
 */
export function compatibleWith(serverVersion: string | undefined): boolean {
  if (!serverVersion) return false;
  const line = (version: string) => { const [major, minor] = version.split('.'); return major === '0' ? `0.${minor}` : major; };
  return line(serverVersion) === line(CLI_VERSION);
}
