import type { ApiErrorCode } from '../../../src/shared/types.js';
import { hintFor, t } from './messages.js';

/**
 * Codes the client adds to the server's own (`ApiErrorCode`): `usage` for a
 * bad command line, `not_configured` when no address or token is known,
 * `network`/`timeout` when the server cannot be reached, `bad_response` when
 * the answer is not FeedLantern JSON, `partial_failure` when some items of a
 * batch failed, and `internal` for a bug in the client.
 */
export type ClientErrorCode = ApiErrorCode | 'usage' | 'not_configured' | 'network' | 'timeout' | 'bad_response' | 'partial_failure' | 'internal';

/** Process exit codes, documented in doc/agent.md. */
export const EXIT = {
  ok: 0,
  internal: 1,
  usage: 2,
  auth: 3,
  rejected: 4,
  server: 5,
  network: 6,
  partial: 7,
} as const;

export interface ErrorDetails {
  code: ClientErrorCode;
  /** HTTP status, 0 when no response was received. */
  status: number;
  message: string;
  hint?: string;
  method?: string;
  path?: string;
}

/** Every failure of the client, the CLI and the MCP tools is one of these. */
export class FeedLanternError extends Error {
  readonly code: ClientErrorCode;
  readonly status: number;
  readonly hint?: string;
  readonly method?: string;
  readonly path?: string;
  /** Extra data shown with the error, such as the per-item results of a batch. */
  readonly data?: unknown;

  constructor(details: ErrorDetails & { data?: unknown }) {
    super(details.message);
    this.name = 'FeedLanternError';
    this.code = details.code;
    this.status = details.status;
    this.hint = details.hint ?? hintFor(details.code);
    this.method = details.method;
    this.path = details.path;
    this.data = details.data;
  }

  get exitCode(): number {
    return exitCodeFor(this.code);
  }

  toJSON(): ErrorDetails & { data?: unknown } {
    return {
      code: this.code, status: this.status, message: this.message,
      ...(this.hint ? { hint: this.hint } : {}),
      ...(this.method ? { method: this.method } : {}),
      ...(this.path ? { path: this.path } : {}),
      ...(this.data !== undefined ? { data: this.data } : {}),
    };
  }
}

export function exitCodeFor(code: ClientErrorCode): number {
  switch (code) {
    case 'usage': case 'not_configured': return EXIT.usage;
    case 'unauthorized': case 'forbidden': case 'token_read_only': case 'token_not_allowed': return EXIT.auth;
    case 'validation': case 'not_found': case 'conflict': case 'too_large': case 'rate_limited': case 'source_not_feed': case 'pubmed_query_invalid': return EXIT.rejected;
    case 'server_error': case 'upstream_error': case 'unavailable': case 'bad_response': return EXIT.server;
    case 'network': case 'timeout': return EXIT.network;
    case 'partial_failure': return EXIT.partial;
    default: return EXIT.internal;
  }
}

export function usageError(message: string): FeedLanternError {
  return new FeedLanternError({ code: 'usage', status: 0, message });
}

/** Wraps anything thrown into a FeedLanternError, keeping ours as they are. */
export function asFeedLanternError(error: unknown): FeedLanternError {
  if (error instanceof FeedLanternError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new FeedLanternError({ code: 'internal', status: 0, message: t('errors.internal', { message }) });
}
