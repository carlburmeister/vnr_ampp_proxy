import { randomUUID } from 'node:crypto';
import type { SessionData } from 'express-session';
import type { AmppAccessToken } from '../auth/types/session-data';

// Tokens come only from the server's AMPP connection, never browser headers.
export function storeAmppAccessToken(
  session: SessionData,
  token: string,
  expectedClientId?: string,
): void {
  try {
    const claims = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
    ) as { client_id?: unknown; scope?: unknown; exp?: unknown; iat?: unknown };
    const clientId = claims.client_id;
    const scopes: unknown =
      typeof claims.scope === 'string'
        ? claims.scope.split(/\s+/).filter(Boolean)
        : claims.scope;
    if (
      typeof clientId !== 'string' ||
      !clientId ||
      (expectedClientId !== undefined && clientId !== expectedClientId) ||
      typeof claims.exp !== 'number' ||
      !Number.isFinite(claims.exp * 1000) ||
      !Array.isArray(scopes) ||
      !scopes.length ||
      !scopes.every(
        (scope: unknown) => typeof scope === 'string' && scope.length > 0,
      )
    )
      return;

    const entry: AmppAccessToken = {
      clientId,
      token,
      scopes: [...new Set(scopes as string[])].sort(),
      expiresAt: claims.exp * 1000,
      issuedAt:
        typeof claims.iat === 'number' && Number.isFinite(claims.iat)
          ? claims.iat * 1000
          : 0,
    };
    const key = JSON.stringify([clientId, entry.scopes]);
    const previous = session.amppAccessTokens?.[key];
    if (!previous || newerAmppAccessToken(entry, previous)) {
      session.amppAccessTokens = {
        ...session.amppAccessTokens,
        [key]: entry,
      };
    }
  } catch {
    // Malformed legacy or upstream tokens cannot satisfy scope requirements.
  }
}

export function newerAmppAccessToken(
  left: AmppAccessToken,
  right: AmppAccessToken,
): boolean {
  return (
    left.issuedAt > right.issuedAt ||
    (left.issuedAt === right.issuedAt && left.expiresAt >= right.expiresAt)
  );
}

export function migrateAmppAccessToken(session: SessionData): void {
  // Earlier builds keyed this cache only by client ID. Re-key existing entries
  // from their server-captured token without losing other scope variants.
  for (const [key, entry] of Object.entries(session.amppAccessTokens ?? {})) {
    if (
      entry.clientId &&
      key === JSON.stringify([entry.clientId, entry.scopes])
    )
      continue;
    delete session.amppAccessTokens[key];
    storeAmppAccessToken(session, entry.token, entry.clientId);
  }
  if (session.amppAccessToken)
    storeAmppAccessToken(session, session.amppAccessToken);
  delete session.amppAccessToken;
}

export function clearAmppAccessTokens(session: SessionData): void {
  delete session.amppAccessToken;
  delete session.amppAccessTokens;
  session.amppTokenGeneration = randomUUID();
}
