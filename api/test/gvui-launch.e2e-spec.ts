import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import type { SessionData } from 'express-session';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AmppControlService } from '../src/ampp/services/ampp-control.service';
import { AuthService } from '../src/auth/auth.service';
import { SessionExpiredError } from '../src/auth/mysql-session.store';
import { AmppMatrixFilterService } from '../src/ampp-proxy/ampp-matrix-filter.service';
import { AmppProxyPolicyService } from '../src/ampp-proxy/ampp-proxy-policy.service';
import { AmppProxyController } from '../src/ampp-proxy/ampp-proxy.controller';
import { AmppProxyService } from '../src/ampp-proxy/ampp-proxy.service';
import { AmppProxySessionService } from '../src/ampp-proxy/ampp-proxy-session.service';
import { AmppResponseRewriterService } from '../src/ampp-proxy/ampp-response-rewriter.service';
import { GvuiPhase1Service } from '../src/ampp-proxy/gvui/gvui-phase1.service';
import { GvuiPhase2Service } from '../src/ampp-proxy/gvui/gvui-phase2.service';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const W = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const origin = 'https://ampp.invalid';

// Real session guard, controller and layout/policy services; no live AMPP or SQL.
describe('GVUI launch/access contracts (isolated HTTP)', () => {
  let app: INestApplication<App>;
  let config: ConfigService;
  let session: SessionData;
  let refresh: jest.Mock;
  let catalog: jest.Mock;
  const destroy = jest.fn((done: () => void) => done());

  beforeEach(async () => {
    config = new ConfigService({
      PLATFORM_URL: origin,
      GVUI_PHASE2_ENABLED: 'true',
    });
    session = {
      cookie: {} as SessionData['cookie'],
      user: {
        id: '1',
        username: 'test',
        displayName: 'Test',
        clientId: 1,
        userType: 'user',
      },
      gvuiPhase2Enabled: true,
      allowedGvuiLayoutIds: [A, B],
      allowedGvuiLayouts: [A, B].map((id) => ({
        id,
        name: id,
        associatedWorkloadId: null,
      })),
      allowedWorkloads: [
        {
          id: W,
          name: 'Mixer',
          is_parent: 0,
          packageName: 'Mixer',
          pageType: 'ampp-ui',
        },
      ],
      amppAllowedWorkloadIds: [W],
    };
    refresh = jest.fn().mockResolvedValue(false);
    catalog = jest.fn().mockResolvedValue(
      [A, B].map((id) => ({
        configuration: {
          key: `gv-ui-l/${id}`,
          value: JSON.stringify({
            id,
            components: [
              {
                type: 'web',
                url: `${origin}/app/wrapper/embedded/single/Mixer/${W}`,
              },
            ],
          }),
        },
      })),
    );
    const module = await Test.createTestingModule({
      controllers: [AmppProxyController],
      providers: [
        GvuiPhase2Service,
        GvuiPhase1Service,
        AmppProxyPolicyService,
        AmppMatrixFilterService,
        AmppResponseRewriterService,
        { provide: ConfigService, useValue: config },
        {
          provide: AuthService,
          useValue: { refreshSessionAuthorization: refresh },
        },
        {
          provide: AmppControlService,
          useValue: { getGvuiConfigurations: catalog },
        },
        {
          provide: AmppProxyService,
          useValue: {
            getUiResource: jest.fn().mockResolvedValue({
              status: 200,
              headers: {},
              body: Buffer.from('GVUI document'),
            }),
          },
        },
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
      req.session = Object.assign(session, {
        destroy,
        touch: jest.fn(),
        save: (done: () => void) => done(),
      }) as unknown as Request['session'];
      next();
    });
    await app.init();
  });
  afterEach(async () => {
    await app.close();
    jest.clearAllMocks();
  });

  it('launches independent layouts and returns uncached access decisions', async () => {
    for (const id of [A, B]) {
      const launched = await request(app.getHttpServer())
        .get(`/api/ampp-proxy/gvui/${id}/launch`)
        .expect(200);
      expect(launched.headers['cache-control']).toBe('no-store');
      const url = (launched.body as { url: string }).url;
      expect(url).toBe(`/api/ampp-proxy/ui/gvui-${id}/gvui/desktop/${id}`);
      await request(app.getHttpServer()).get(url).expect(200);
      const access = await request(app.getHttpServer())
        .get(`/api/ampp-proxy/gvui/${id}/access`)
        .expect(200);
      expect((access.body as { allowed: boolean }).allowed).toBe(true);
      expect(access.headers['cache-control']).toBe('no-store');
    }
  });

  it('rejects ungranted launches, unestablished contexts and other-layout deep links', async () => {
    await request(app.getHttpServer())
      .get(`/api/ampp-proxy/ui/gvui-${A}/gvui/desktop/${A}`)
      .expect(403);
    session.allowedGvuiLayoutIds = [A];
    await request(app.getHttpServer())
      .get(`/api/ampp-proxy/gvui/${B}/launch`)
      .expect(403);
    expect(catalog).not.toHaveBeenCalled();
    await request(app.getHttpServer())
      .get(`/api/ampp-proxy/gvui/${A}/launch`)
      .expect(200);
    await request(app.getHttpServer())
      .get(`/api/ampp-proxy/ui/gvui-${A}/gvui/desktop/${B}`)
      .expect(403);
  });

  it('uses refreshed grants to revoke an open context', async () => {
    await request(app.getHttpServer())
      .get(`/api/ampp-proxy/gvui/${A}/launch`)
      .expect(200);
    refresh.mockImplementation(() => {
      session.allowedGvuiLayoutIds = [];
      return Promise.resolve(true);
    });
    const access = await request(app.getHttpServer())
      .get(`/api/ampp-proxy/gvui/${A}/access`)
      .expect(200);
    expect((access.body as { allowed: boolean }).allowed).toBe(false);
    await request(app.getHttpServer())
      .get(`/api/ampp-proxy/ui/gvui-${A}/gvui/dist/app.js`)
      .expect(403);
  });

  it('rejects expired sessions before querying AMPP', async () => {
    refresh.mockRejectedValue(new SessionExpiredError());
    const expired = await request(app.getHttpServer())
      .get(`/api/ampp-proxy/gvui/${A}/launch`)
      .expect(401);
    expect((expired.body as { code: string }).code).toBe('SESSION_EXPIRED');
    expect(destroy).toHaveBeenCalled();
    expect(catalog).not.toHaveBeenCalled();
  });

  it('keeps grants after an AMPP outage and rejects launches while disabled', async () => {
    catalog.mockRejectedValue(new Error('offline'));
    await request(app.getHttpServer())
      .get(`/api/ampp-proxy/gvui/${A}/launch`)
      .expect(502);
    expect(session.allowedGvuiLayoutIds).toEqual([A, B]);
    config.set('GVUI_PHASE2_ENABLED', 'false');
    await request(app.getHttpServer())
      .get(`/api/ampp-proxy/gvui/${A}/launch`)
      .expect(403);
  });
});
