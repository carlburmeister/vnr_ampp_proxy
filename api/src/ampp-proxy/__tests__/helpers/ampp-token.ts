import type { SessionData } from 'express-session';

export function amppToken(
  clientId: string,
  scope: unknown = ['platform', 'cluster'],
  claims: Record<string, unknown> = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  return (
    'header.' +
    Buffer.from(
      JSON.stringify({
        client_id: clientId,
        scope,
        iat: now,
        exp: now + 14400,
        ...claims,
      }),
    ).toString('base64url') +
    '.test-signature'
  );
}
export function cachedAmppToken(
  session: Partial<SessionData>,
  clientId: string,
) {
  return Object.values(session.amppAccessTokens ?? {}).find(
    (entry) => entry.clientId === clientId,
  );
}
