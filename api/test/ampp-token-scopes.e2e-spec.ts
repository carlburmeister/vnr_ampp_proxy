import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Request, Response, NextFunction } from 'express';
import type { SessionData } from 'express-session';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AuthService } from '../src/auth/auth.service';
import { SessionAuthGuard } from '../src/auth/session-auth.guard';
import { AmppApiProxyController } from '../src/ampp-proxy/ampp-api-proxy.controller';
import { AmppProxyPolicyService } from '../src/ampp-proxy/ampp-proxy-policy.service';
import { AmppProxyService } from '../src/ampp-proxy/ampp-proxy.service';
import { AmppProxySessionService } from '../src/ampp-proxy/ampp-proxy-session.service';
import { AmppBearerTokenService } from '../src/ampp-proxy/ampp-bearer-token.service';
import type { AmppCookieHttpService } from '../src/ampp-proxy/ampp-cookie-http.service';
import { AmppResponseRewriterService } from '../src/ampp-proxy/ampp-response-rewriter.service';
import { storeAmppAccessToken } from '../src/ampp-proxy/ampp-access-tokens';
import { amppToken } from '../src/ampp-proxy/__tests__/helpers/ampp-token';

const ALLOWED = 'fbab1aa9-405b-460d-abfa-83a239981f5e';
const DENIED = '19876769-99e5-4685-a7e2-95d8c0720284';

// Real guard, policy, API controller, token selector and response rewriter.
// No live AMPP, credentials or database are used.
describe('Scope-aware bearer selection with workload authorization (isolated HTTP)', () => {
  let app: INestApplication<App>;
  let session: SessionData;
  let upstream: jest.MockedFunction<AmppCookieHttpService['request']>;
  let fallback: jest.SpyInstance<Promise<string>, []>;
  const clusterToken = amppToken('wrapper');
  beforeEach(async () => {
    const config = new ConfigService({ PLATFORM_URL: 'https://ampp.invalid' });
    const bearer = new AmppBearerTokenService(config);
    fallback = jest
      .spyOn(bearer, 'getToken')
      .mockResolvedValue(amppToken('api-key'));
    session = {
      user: { id: 'test-user' },
      allowedWorkloads: [
        {
          id: ALLOWED,
          name: 'SRT Input #1',
          is_parent: 0,
          pageType: 'ampp-ui',
        },
      ],
      amppAllowedWorkloadIds: [ALLOWED],
    } as SessionData;
    storeAmppAccessToken(session, clusterToken);
    storeAmppAccessToken(session, amppToken('gvui', ['platform', 'openid']));
    upstream = jest.fn().mockResolvedValue({
      status: 200,
      body: Buffer.from('{}'),
      headers: { 'content-type': 'application/json' },
      url: 'https://ampp.invalid/cluster/state/api/v1/workload/' + ALLOWED,
    });
    const filter = {
      filterApiResponse: (_s: unknown, _w: string, _p: string, r: unknown) => r,
    };
    const proxy = new AmppProxyService(
      config,
      bearer,
      {} as never,
      { request: upstream } as never,
      filter as never,
      filter as never,
      new AmppResponseRewriterService(config),
      {
        getCookieJar: () => Promise.resolve({}),
        saveCookieJar: () => {},
      } as never,
      {} as never,
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
    const module = await Test.createTestingModule({
      controllers: [AmppApiProxyController],
      providers: [
        SessionAuthGuard,
        { provide: ConfigService, useValue: config },
        {
          provide: AuthService,
          useValue: {
            refreshSessionAuthorization: () => Promise.resolve(false),
          },
        },
        {
          provide: AmppProxyPolicyService,
          useValue: new AmppProxyPolicyService({} as never),
        },
        { provide: AmppProxyService, useValue: proxy },
        {
          provide: AmppProxySessionService,
          useValue: {
            snapshot: () => ({}),
            saveIfChanged: () => Promise.resolve(),
          },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.session = session as Request['session'];
      next();
    });
    await app.init();
  });
  afterEach(async () => app.close());
  const url = (id = ALLOWED, context = ALLOWED) =>
    `/api/ampp-proxy/api/${context}/cluster/state/api/v1/workload/${id}`;

  it('uses the cluster token after a GVUI renewal despite a browser Authorization header', async () => {
    await request(app.getHttpServer())
      .get(url())
      .set('Authorization', 'Bearer browser-placeholder')
      .expect(200);
    expect(upstream.mock.lastCall[2].headers.Authorization).toBe(
      'Bearer ' + clusterToken,
    );
    expect(fallback).not.toHaveBeenCalled();
  });
  it('keeps SRT Input #2 forbidden as target and as context', async () => {
    await request(app.getHttpServer()).get(url(DENIED)).expect(403);
    await request(app.getHttpServer()).get(url(ALLOWED, DENIED)).expect(403);
    expect(upstream).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });
  it('keeps denied workload control forbidden before selecting any token', async () => {
    await request(app.getHttpServer())
      .post(
        `/api/ampp-proxy/api/${ALLOWED}/cluster/control/api/v1/workload/${DENIED}/stop`,
      )
      .expect(403);
    expect(upstream).not.toHaveBeenCalled();
  });
  it('uses the existing fallback for an allowed cluster read when only a GVUI token remains', async () => {
    delete session.amppAccessTokens.wrapper;
    await request(app.getHttpServer()).get(url()).expect(200);
    expect(fallback).toHaveBeenCalledTimes(1);
  });
});
