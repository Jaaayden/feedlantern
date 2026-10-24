import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ApiTokenScope, AuthState } from '../shared/types.js';
import type { ServerConfig } from './config.js';
import { Store, verifyPassword } from './store.js';
import { errorCode, instanceLocale, LocalizedError, textOf, type LocalizedText, type SimpleErrorKey } from './i18n.js';

export const SESSION_COOKIE = 'feedlantern_session';

/**
 * An error returned to the API client: `code` is stable, and the message is
 * translated into the reader's language when the response is sent.
 */
export class AppError extends LocalizedError {
  readonly statusCode: number;
  readonly code: string;
  constructor(statusCode: number, text: LocalizedText | SimpleErrorKey) {
    super(textOf(text));
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = errorCode(this.text);
  }
}

export function validatePassword(password: unknown): password is string {
  return typeof password === 'string' && password.length >= 8 && password.length <= 1024;
}

export function validateUsername(username: unknown): username is string {
  return typeof username === 'string' && /^[^\s]{1,100}$/.test(username);
}

export class LoginRateLimiter {
  private readonly failures = new Map<string, number[]>();
  readonly maxAttempts: number;
  readonly windowMs: number;

  constructor(maxAttempts = 8, windowMs = 15 * 60_000) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
  }

  private clean(key: string, now = Date.now()): number[] {
    const kept = (this.failures.get(key) ?? []).filter((time) => now - time < this.windowMs);
    if (kept.length) this.failures.set(key, kept);
    else this.failures.delete(key);
    return kept;
  }

  allowed(key: string): boolean {
    if (this.failures.size >= 10_000 && !this.failures.has(key)) {
      for (const existing of this.failures.keys()) this.clean(existing);
      if (this.failures.size >= 10_000) return false;
    }
    return this.clean(key).length < this.maxAttempts;
  }

  registerFailure(key: string): number {
    const now = Date.now();
    const failures = this.clean(key, now);
    failures.push(now);
    this.failures.set(key, failures);
    return Math.max(1, Math.ceil((this.windowMs - (now - failures[0])) / 1000));
  }

  clear(key: string): void {
    this.failures.delete(key);
  }
}

export interface AuthContext {
  userId: string;
  role: "admin" | "user";
  /** Empty for token requests, which have no browser session. */
  sessionId: string;
  username: string;
  expiresAt: number;
  /** Present when the request was authenticated with a personal access token. */
  token?: { id: string; scope: ApiTokenScope };
}

/**
 * The token from an `Authorization: Bearer` header: undefined when the request
 * has no bearer credentials (other schemes, such as a proxy's Basic auth, are
 * ignored), and an empty string when the header is a malformed bearer value.
 */
export function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const match = /^bearer(?:\s+(.*))?$/i.exec(header.trim());
  if (!match) return undefined;
  return match[1]?.trim() ?? '';
}

export function sessionFromRequest(request: FastifyRequest, store: Store, config: ServerConfig): AuthContext | null {
  // A bearer request is authenticated by its token alone; cookies are ignored.
  const bearer = bearerToken(request);
  if (bearer !== undefined) {
    const owner = store.tokens.find(bearer);
    return owner ? { userId: owner.userId, role: owner.role, sessionId: '', username: owner.username, expiresAt: owner.expiresAt ? Date.parse(owner.expiresAt) : Number.MAX_SAFE_INTEGER, token: { id: owner.tokenId, scope: owner.scope } } : null;
  }
  const raw = request.cookies?.[config.cookieName] ?? request.cookies?.[SESSION_COOKIE];
  const session = store.findSession(raw, config.sessionTtlMs);
  return session ? { userId: session.userId, role: session.role, sessionId: raw!, username: session.username, expiresAt: session.expiresAt } : null;
}

export function requireAuth(request: FastifyRequest, store: Store, config: ServerConfig): AuthContext {
  const session = sessionFromRequest(request, store, config);
  if (!session) throw new AppError(401, 'error.signInRequired');
  return session;
}

export function requireCsrf(request: FastifyRequest, store: Store, context: AuthContext): void {
  // A cross-site page cannot attach a bearer token, so token requests need no CSRF token,
  // but a write still needs a write token.
  if (context.token) {
    if (context.token.scope !== 'write') throw new AppError(403, 'error.readOnlyToken');
    return;
  }
  const csrf = request.headers['x-csrf-token'];
  const token = Array.isArray(csrf) ? csrf[0] : csrf;
  if (!store.checkCsrf(context.sessionId, token)) throw new AppError(403, 'error.csrfInvalid');
}

export function setSessionCookie(reply: FastifyReply, config: ServerConfig, sessionId: string): void {
  reply.setCookie(config.cookieName || SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.cookieSecure,
    path: '/',
    maxAge: Math.floor(config.sessionTtlMs / 1000),
  });
}

export function clearSessionCookie(reply: FastifyReply, config: ServerConfig): void {
  reply.clearCookie(config.cookieName || SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.cookieSecure,
    path: '/',
  });
}

export function authState(store: Store, config: ServerConfig, context: AuthContext | null, csrfToken?: string): AuthState {
  return {
    setupRequired: !store.hasAdmin(),
    authenticated: Boolean(context),
    ...(context ? { userId: context.userId, role: context.role, username: context.username, csrfToken, locale: store.userLocale(context.userId), ...(context.token ? { tokenScope: context.token.scope } : {}) } : {}),
    version: config.version,
    defaultLocale: instanceLocale(),
  };
}

export function issueCsrf(store: Store, context: AuthContext): string {
  return store.issueCsrf(context.sessionId);
}

export function authenticate(store: Store, username: string, password: string): boolean {
  return store.authenticate(username, password);
}

export function generateSetupToken(): string {
  return randomBytes(32).toString('hex');
}

// Kept as a small exported helper for the reset-password command and tests.
export { verifyPassword };
