import { ConfigService } from '@nestjs/config';
import type { SessionData } from 'express-session';
import { AmppBearerTokenService } from '../ampp-bearer-token.service';
import type { AmppCookieHttpService } from '../ampp-cookie-http.service';
import { AmppBrowserSecurityService } from '../ampp-browser-security.service';
import { AmppProxyService } from '../ampp-proxy.service';
import { AmppResponseRewriterService } from '../ampp-response-rewriter.service';
import { amppToken, cachedAmppToken } from './helpers/ampp-token';
import { applicationRequests } from './helpers/ampp-application-requests';

const PLATFORM = 'https://ampp.invalid';
const WORKLOADS = [
  'bc8a392e-f043-467b-8358-7dfab9d13ea0',
  'fbab1aa9-405b-460d-abfa-83a239981f5e',
  'cbda2ccd-a99f-4c6a-8e82-1e0948858441',
  '6ac0ee96-f6cb-46d2-be4e-00034ad72943',
];

// Exercise capture, selection, upstream Authorization, and real response rewriting.
// Only upstream HTTP and the unrelated resource filters are replaced.
describe('AMPP bearer routing across OAuth renewals', () => {
  let proxy: AmppProxyService;
  let bearer: AmppBearerTokenService;
  let session: SessionData;
  let request: jest.MockedFunction<AmppCookieHttpService['request']>;
  let fallback: jest.SpyInstance<Promise<string>, []>;
  const wrapper = () => amppToken('wrapper', ['cluster', 'platform', 'openid']);
  const gvui = () => amppToken('gvui', ['platform', 'openid']);
  function response(status = 200) {
    return {
      status,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{}'),
      url: PLATFORM + '/cluster/state/api/v1/workload/id',
    };
  }
  beforeEach(() => {
    const config = new ConfigService({ PLATFORM_URL: PLATFORM });
    bearer = new AmppBearerTokenService(config);
    fallback = jest
      .spyOn(bearer, 'getToken')
      .mockResolvedValue(amppToken('api-key'));
    session = {} as SessionData;
    request = jest.fn().mockResolvedValue(response());
    const filter = {
      filterApiResponse: (_s: unknown, _w: string, _p: string, r: unknown) => r,
    };
    proxy = new AmppProxyService(
      config,
      bearer,
      new AmppBrowserSecurityService(),
      { request } as never,
      filter as never,
      filter as never,
      new AmppResponseRewriterService(config),
      {
        getCookieJar: () => Promise.resolve({}),
        saveCookieJar: () => {},
      } as never,
      { isLoginResponse: () => false } as never,
      {
        isCatalogRequest: () => false,
        prepareApiRequest: (
          _s: unknown,
          _w: string,
          _m: string,
          path: string,
          body?: Buffer,
        ) => ({ path, body }),
        completeApiRequest: (
          _s: unknown,
          _w: string,
          _p: unknown,
          r: unknown,
        ) => r,
        ...filter,
      } as never,
    );
  });

  async function renew(client: string, token: string) {
    const path = '/identity/connect/authorize?client_id=' + client;
    request.mockResolvedValueOnce({
      ...response(302),
      headers: {
        location: PLATFORM + '/app/wrapper/refresh.html#access_token=' + token,
      },
    });
    await proxy.getUiResource(
      'sid',
      session,
      WORKLOADS[0],
      path,
      {},
      'https://proxy.invalid',
    );
  }
  async function api(
    path = '/cluster/state/api/v1/workload/' + WORKLOADS[0],
    method = 'GET',
    workloadId = WORKLOADS[0],
  ) {
    return proxy.proxyApiRequest(
      'sid',
      session,
      workloadId,
      method,
      path,
      {},
      undefined,
      'https://proxy.invalid',
    );
  }

  describe.each([
    ['wrapper', 'gvui'],
    ['gvui', 'wrapper'],
  ])('application initialization after %s then %s', (first, second) => {
    it.each(applicationRequests)(
      'authorizes $name in a standalone frame sharing the GVUI session',
      async ({ path, workloadId }) => {
        const tokens: Record<string, string> = {
          wrapper: wrapper(),
          gvui: gvui(),
        };
        for (const client of [first, second])
          await renew(client, tokens[client]);
        // These captured application APIs require cluster access. An unsuitable
        // bearer receives 403 instead of the old unconditional-success fixture.
        request.mockImplementation((_jar, _path, options) => {
          const token = options.headers.Authorization.slice('Bearer '.length);
          const claims = JSON.parse(
            Buffer.from(token.split('.')[1], 'base64url').toString(),
          ) as { scope: string[] };
          return Promise.resolve(
            response(claims.scope.includes('cluster') ? 200 : 403),
          );
        });
        expect((await api(path, 'GET', workloadId)).status).toBe(200);
        expect(request.mock.lastCall[2].headers.Authorization).toBe(
          'Bearer ' + tokens.wrapper,
        );
        expect(fallback).not.toHaveBeenCalled();
      },
    );
  });

  it('keeps application access across ten hours of interleaved wrapper and GVUI renewals', async () => {
    const start = Date.now();
    const clock = jest.spyOn(Date, 'now');
    try {
      await renew('wrapper', wrapper());
      await renew('gvui', gvui());
      request.mockImplementation((_jar, path, options) => {
        const token = options.headers.Authorization.slice('Bearer '.length);
        const claims = JSON.parse(
          Buffer.from(token.split('.')[1], 'base64url').toString(),
        ) as { scope: string[] };
        const expected = applicationRequests.some(
          (request) => request.path === path,
        )
          ? 'cluster'
          : 'platform';
        return Promise.resolve(
          response(claims.scope.includes(expected) ? 200 : 403),
        );
      });
      for (let hour = 1; hour <= 10; hour++) {
        clock.mockReturnValue(start + hour * 3600000);
        if (hour % 3 === 0) await renew('wrapper', wrapper());
        if (hour % 3 === 1) await renew('gvui', gvui());
        for (const { path, workloadId } of applicationRequests) {
          expect((await api(path, 'GET', workloadId)).status).toBe(200);
        }
        expect((await api('/identity/api/v1/user')).status).toBe(200);
      }
      expect(fallback).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it.each([
    ['wrapper', 'gvui'],
    ['gvui', 'wrapper'],
  ])(
    'keeps all four workloads usable after %s then %s renewal',
    async (first, second) => {
      const tokens: Record<string, string> = {
        wrapper: wrapper(),
        gvui: gvui(),
      };
      for (const client of [first, second]) await renew(client, tokens[client]);
      request.mockClear();
      for (const id of WORKLOADS)
        expect((await api('/cluster/state/api/v1/workload/' + id)).status).toBe(
          200,
        );
      for (const call of request.mock.calls)
        expect(call[2].headers.Authorization).toBe('Bearer ' + tokens.wrapper);
      await api('/identity/api/v1/user');
      expect(request.mock.lastCall[2].headers.Authorization).toBe(
        'Bearer ' + tokens.gvui,
      );
      expect(fallback).not.toHaveBeenCalled();
    },
  );

  it('uses the existing server fallback when a legacy GVUI token lacks cluster scope', async () => {
    session.amppAccessToken = gvui();
    await api();
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(request.mock.lastCall[2].headers.Authorization).toBe(
      'Bearer ' + (await fallback.mock.results[0].value),
    );
  });

  it('returns genuine upstream 403 without retrying or discarding valid tokens', async () => {
    await renew('wrapper', wrapper());
    request.mockClear().mockResolvedValue(response(403));
    const before = JSON.stringify(session.amppAccessTokens);
    expect((await api()).status).toBe(403);
    expect(request).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
    expect(JSON.stringify(session.amppAccessTokens)).toBe(before);
  });

  it('invalidates only a rejected session token and preserves the existing 401 contract', async () => {
    await renew('wrapper', wrapper());
    await renew('gvui', gvui());
    request.mockClear().mockResolvedValueOnce(response(401));
    expect((await api()).status).toBe(401);
    expect(cachedAmppToken(session, 'wrapper')).toBeUndefined();
    expect(cachedAmppToken(session, 'gvui')).toBeDefined();
    await api();
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('retains the existing single retry when a fallback token receives 401', async () => {
    const invalidate = jest.spyOn(bearer, 'invalidate');
    request
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(response());
    expect((await api()).status).toBe(200);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(2);
    expect(fallback).toHaveBeenCalledTimes(2);
  });
});
