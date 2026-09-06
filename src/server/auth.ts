import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthState } from '../shared/types.js';
import type { ServerConfig } from './config.js';
import { Store, verifyPassword } from './store.js';

export const SESSION_COOKIE = 'feedlantern_session';

export class AppError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
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
  sessionId: string;
  username: string;
  expiresAt: number;
}

export function sessionFromRequest(request: FastifyRequest, store: Store, config: ServerConfig): AuthContext | null {
  const raw = request.cookies?.[config.cookieName] ?? request.cookies?.[SESSION_COOKIE];
  const session = store.findSession(raw, config.sessionTtlMs);
  return session ? { sessionId: raw!, username: session.username, expiresAt: session.expiresAt } : null;
}

export function requireAuth(request: FastifyRequest, store: Store, config: ServerConfig): AuthContext {
  const session = sessionFromRequest(request, store, config);
  if (!session) throw new AppError(401, '请先登录');
  return session;
}

export function requireCsrf(request: FastifyRequest, store: Store, context: AuthContext): void {
  const csrf = request.headers['x-csrf-token'];
  const token = Array.isArray(csrf) ? csrf[0] : csrf;
  if (!store.checkCsrf(context.sessionId, token)) throw new AppError(403, '请求验证已失效，请刷新页面后重试');
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
    ...(context ? { username: context.username, csrfToken } : {}),
    version: config.version,
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
