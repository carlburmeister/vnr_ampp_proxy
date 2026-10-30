import { ConfigService } from '@nestjs/config';
import type { SessionData } from 'express-session';
import { AmppBearerTokenService } from '../ampp-bearer-token.service';
import {
  clearAmppAccessTokens,
  storeAmppAccessToken,
} from '../ampp-access-tokens';
import { amppToken } from './helpers/ampp-token';

describe('AMPP session bearer selection', () => {
  let service: AmppBearerTokenService;
  let session: SessionData;
  beforeEach(() => {
    service = new AmppBearerTokenService(new ConfigService());
    session = {} as SessionData;
  });

  it.each([
    ['wrapper', 'gvui'],
    ['gvui', 'wrapper'],
  ])(
    'preserves cluster access after renewals in order %s, %s',
    (first, second) => {
      const tokens: Record<string, string> = {
        wrapper: amppToken('wrapper', ['cluster', 'platform', 'openid']),
        gvui: amppToken('gvui', 'platform openid'),
      };
      for (const client of [first, second])
        storeAmppAccessToken(session, tokens[client]);
      expect(
        service.getSessionToken(
          session,
          'GET',
          '/cluster/state/api/v1/workload/id',
        ),
      ).toBe(tokens.wrapper);
      expect(
        service.getSessionToken(session, 'GET', '/identity/api/v1/user'),
      ).toBe(tokens.gvui);
      expect(Object.keys(session.amppAccessTokens)).toHaveLength(2);
    },
  );

  it.each(['state', 'control', 'matrix', 'fabric', 'snapshot'])(
    'requires cluster access for %s APIs',
    (api) => {
      session.amppAccessToken = amppToken('gvui', ['platform', 'openid']);
      expect(
        service.getSessionToken(session, 'GET', `/cluster/${api}/api/v1/items`),
      ).toBeUndefined();
      expect(session.amppAccessToken).toBeUndefined();
      expect(
        service.getSessionToken(
          session,
          'GET',
          '/cluster/store/api/store/apps',
        ),
      ).toBeDefined();
    },
  );

  it.each(['cluster', 'platform'])(
    'accepts %s.readonly for reads but not writes',
    (scope) => {
      const token = amppToken('reader', [`${scope}.readonly`]);
      storeAmppAccessToken(session, token);
      const path =
        scope === 'cluster'
          ? '/cluster/matrix/api/v1/producer/id'
          : '/configuration/api/v1/configuration/key';
      expect(service.getSessionToken(session, 'GET', path)).toBe(token);
      expect(service.getSessionToken(session, 'HEAD', path)).toBe(token);
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        expect(service.getSessionToken(session, method, path)).toBeUndefined();
      }
    },
  );

  it('accepts full scopes for writes and requires platform for notification connections', () => {
    const token = amppToken('writer');
    storeAmppAccessToken(session, token);
    expect(
      service.getSessionToken(
        session,
        'PUT',
        '/cluster/matrix/api/v1/producer/id',
      ),
    ).toBe(token);
    expect(
      service.getSessionToken(session, 'POST', '/pushnotificationshub'),
    ).toBe(token);
    storeAmppAccessToken(session, amppToken('cluster-only', ['cluster']));
    service.clearSessionToken(session, token);
    expect(
      service.getSessionToken(session, 'POST', '/pushnotificationshub'),
    ).toBeUndefined();
  });

  it('migrates a valid legacy token without replacing a newer token for its client', () => {
    const now = Math.floor(Date.now() / 1000);
    const newer = amppToken('wrapper', ['platform', 'cluster'], { iat: now });
    storeAmppAccessToken(session, newer);
    session.amppAccessToken = amppToken('wrapper', ['platform', 'cluster'], {
      iat: now - 100,
    });
    expect(
      service.getSessionToken(
        session,
        'GET',
        '/cluster/state/api/v1/workload/id',
      ),
    ).toBe(newer);
    expect(session.amppAccessToken).toBeUndefined();
  });

  it.each([
    'opaque',
    amppToken('wrapper', undefined, { scope: null }),
    amppToken('wrapper', [], {}),
    amppToken('wrapper', ['platform'], { exp: null }),
    amppToken('wrapper', ['platform'], { client_id: null }),
  ])('ignores malformed legacy token %#', (token) => {
    session.amppAccessToken = token;
    expect(service.getSessionToken(session)).toBeUndefined();
    expect(session.amppAccessToken).toBeUndefined();
  });

  it.each([-10, 60])(
    'does not select a token expiring in %s seconds',
    (seconds) => {
      const exp = Math.floor(Date.now() / 1000) + seconds;
      storeAmppAccessToken(
        session,
        amppToken('wrapper', ['platform', 'cluster'], { exp }),
      );
      expect(service.getSessionToken(session)).toBeUndefined();
      expect(session.amppAccessTokens).toEqual({});
    },
  );

  it('rejects an unexpected OAuth client without overwriting existing entries', () => {
    const token = amppToken('wrapper');
    storeAmppAccessToken(session, token, 'wrapper');
    storeAmppAccessToken(session, amppToken('gvui'), 'wrapper');
    expect(Object.keys(session.amppAccessTokens)).toEqual(['wrapper']);
  });

  it('invalidates only the rejected token, preserving replacements and other clients', () => {
    const token = amppToken('wrapper');
    const other = amppToken('gvui', ['platform']);
    storeAmppAccessToken(session, token);
    storeAmppAccessToken(session, other);
    service.clearSessionToken(session, token);
    expect(service.getSessionToken(session)).toBe(other);
    const replacement = amppToken('wrapper', ['platform', 'cluster'], {
      iat: Math.floor(Date.now() / 1000) + 1,
    });
    storeAmppAccessToken(session, replacement);
    service.clearSessionToken(session, token);
    expect(session.amppAccessTokens.wrapper.token).toBe(replacement);
  });

  it('clears all cached and legacy tokens when authentication resets', () => {
    session.amppAccessToken = amppToken('legacy');
    storeAmppAccessToken(session, amppToken('wrapper'));
    clearAmppAccessTokens(session);
    expect(session.amppAccessToken).toBeUndefined();
    expect(session.amppAccessTokens).toBeUndefined();
    expect(session.amppTokenGeneration).toEqual(expect.any(String));
    const generation = session.amppTokenGeneration;
    clearAmppAccessTokens(session);
    expect(session.amppTokenGeneration).not.toBe(generation);
  });
});
