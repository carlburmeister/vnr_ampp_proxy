import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { raw, type NextFunction, type Request, type Response } from 'express';
import type { SessionData } from 'express-session';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AuthService } from '../src/auth/auth.service';
import { AmppApiProxyController } from '../src/ampp-proxy/ampp-api-proxy.controller';
import { AmppBearerTokenService } from '../src/ampp-proxy/ampp-bearer-token.service';
import type { AmppCookieHttpService } from '../src/ampp-proxy/ampp-cookie-http.service';
import { AmppDashboardFilterService } from '../src/ampp-proxy/ampp-dashboard-filter.service';
import { AmppMatrixFilterService } from '../src/ampp-proxy/ampp-matrix-filter.service';
import { AmppProxyPolicyService } from '../src/ampp-proxy/ampp-proxy-policy.service';
import { AmppProxyService } from '../src/ampp-proxy/ampp-proxy.service';
import { AmppProxySessionService } from '../src/ampp-proxy/ampp-proxy-session.service';
import { AmppResponseRewriterService } from '../src/ampp-proxy/ampp-response-rewriter.service';
import { GvuiProxyService } from '../src/ampp-proxy/gvui/gvui-proxy.service';

const WORKLOAD = '2e74ea96-1ec3-4a93-98a4-baa717055bcb';
const RECORDER = 'de712c28-4138-487f-9e7a-817d27a15f9d';
const OTHER = '11111111-1111-4111-8111-111111111111';
const OTHER_RECORDER = '22222222-2222-4222-8222-222222222222';
const DENIED = '33333333-3333-4333-8333-333333333333';
const MAILBOX = `ts-api.ampp-proxy.ui.${WORKLOAD}.app.wrapper--${OTHER}`;
const ORIGIN = 'https://ampp.invalid';
const settings = (id = WORKLOAD) =>
  `/mocha/application/${id}/api/v1/app/recordingsettings`;
const api = (path: string, context = WORKLOAD) =>
  `/api/ampp-proxy/api/${context}${path}`;
const subscription = (id = RECORDER, action = 'subscribe', mailbox = MAILBOX) =>
  `/notifications/api/v1/mailbox/${mailbox}/${action}/gv.fabric.recorder.${id}.%23`;
const prepared = {
  topic: `gv.fabric.recorder.${RECORDER}.info`,
  content: JSON.stringify({
    serviceHealth: { health: 'OK' },
    state: 'prepared',
  }),
};

// Real guard, policy, proxy, response filters, controller and session merge.
// Only upstream AMPP/authentication and the persistent session store are fixtures.
describe('Clip Recorder subscription lifecycle over HTTP', () => {
  let app: INestApplication<App>;
  let stored: SessionData;
  let upstream: jest.MockedFunction<AmppCookieHttpService['request']>;
  let settingsStatus: number;
  let settingsBody: string;
  let revokeOnRead: boolean;

  beforeEach(async () => {
    settingsStatus = 200;
    settingsBody = JSON.stringify({ recorderId: RECORDER });
    revokeOnRead = false;
    stored = {
      user: { id: 'test-user' },
      authorizationFingerprint: 'granted',
      allowedWorkloads: [WORKLOAD, OTHER].map((id) => ({
        id,
        name: id,
        pageType: 'ampp-ui',
        is_parent: 0,
      })),
      amppAllowedWorkloadIds: [WORKLOAD, OTHER],
    } as SessionData;
    const config = new ConfigService({ PLATFORM_URL: ORIGIN });
    const matrix = new AmppMatrixFilterService(config);
    const gvui = new GvuiProxyService(config, {} as never);
    upstream = jest.fn((_jar, path) =>
      Promise.resolve({
        url: ORIGIN + path,
        status:
          path.includes('/subscribe/') || path.includes('/unsubscribe/')
            ? 204
            : settingsStatus,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(
          path.includes('/notifications/api/v1/notifications/')
            ? JSON.stringify([prepared])
            : path.endsWith('/preparerecording')
              ? JSON.stringify({ state: 5 })
              : settingsBody,
        ),
      }),
    );
    const proxy = new AmppProxyService(
      config,
      { getSessionToken: () => 'test-token' } as AmppBearerTokenService,
      {} as never,
      { request: upstream } as never,
      new AmppDashboardFilterService(config),
      matrix,
      new AmppResponseRewriterService(config),
      {
        getCookieJar: () => Promise.resolve({}),
        saveCookieJar: () => {},
      } as never,
      {} as never,
      gvui,
    );
    const module = await Test.createTestingModule({
      controllers: [AmppApiProxyController],
      providers: [
        { provide: ConfigService, useValue: config },
        {
          provide: AuthService,
          useValue: {
            refreshSessionAuthorization: () => Promise.resolve(false),
          },
        },
        {
          provide: AmppProxyPolicyService,
          useValue: new AmppProxyPolicyService(matrix, gvui),
        },
        { provide: AmppProxyService, useValue: proxy },
        AmppProxySessionService,
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.use(raw({ type: () => true }));
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.sessionID = 'recorder-session';
      req.session = Object.assign(structuredClone(stored), {
        touch: () => {},
        save: (done: () => void) => {
          stored = JSON.parse(JSON.stringify(req.session)) as SessionData;
          done();
        },
      }) as Request['session'];
      req.sessionStore = {
        get: (_id: string, done: (error: null, s: SessionData) => void) => {
          if (revokeOnRead) {
            stored.authorizationFingerprint = 'revoked';
            stored.allowedWorkloads = [];
            stored.amppAllowedWorkloadIds = [];
            delete (stored as unknown as Record<string, unknown>)
              .amppRecorderIdsByWorkload;
          }
          done(null, structuredClone(stored));
        },
      } as never;
      next();
    });
    await app.init();
  });
  afterEach(async () => app.close());

  it('persists the AMPP recorder ID before subscribing and passes the prepared event', async () => {
    await request(app.getHttpServer()).post(api(subscription())).expect(403);
    expect(upstream).not.toHaveBeenCalled();
    await request(app.getHttpServer()).get(api(settings())).expect(200);
    expect(stored).toMatchObject({
      amppRecorderIdsByWorkload: { [WORKLOAD]: RECORDER },
    });
    await request(app.getHttpServer()).post(api(subscription())).expect(204);
    await request(app.getHttpServer())
      .post(api(settings()))
      .send({ recorderId: RECORDER, fileName: '20261106_proxy1' })
      .expect(200);
    await request(app.getHttpServer())
      .post(api(settings().replace('recordingsettings', 'preparerecording')))
      .send({ state: 0 })
      .expect(200, { state: 5 });
    const response = await request(app.getHttpServer())
      .get(
        api(
          `/notifications/api/v1/notifications/${MAILBOX}?count=100&timeout=10000`,
        ),
      )
      .expect(200);
    expect(response.body).toEqual([prepared]);
    await request(app.getHttpServer())
      .post(api(subscription(RECORDER, 'unsubscribe')))
      .expect(204);
  });

  it('keeps the association when saving a different recording profile', async () => {
    await request(app.getHttpServer()).get(api(settings())).expect(200);
    await request(app.getHttpServer())
      .post(api(settings()))
      .send({ recorderId: RECORDER, profile: 'nvavc-5mbps-8xaac-mov.xml' })
      .expect(200);
    await request(app.getHttpServer()).post(api(subscription())).expect(204);
  });

  it('normalizes the ID returned by AMPP', async () => {
    settingsBody = JSON.stringify({ recorderId: RECORDER.toUpperCase() });
    await request(app.getHttpServer()).get(api(settings())).expect(200);
    await request(app.getHttpServer()).post(api(subscription())).expect(204);
  });

  it('replaces an old recorder ID on a later settings GET', async () => {
    await request(app.getHttpServer()).get(api(settings())).expect(200);
    settingsBody = JSON.stringify({ recorderId: OTHER_RECORDER });
    await request(app.getHttpServer()).get(api(settings())).expect(200);
    await request(app.getHttpServer()).post(api(subscription())).expect(403);
    await request(app.getHttpServer())
      .post(api(subscription(OTHER_RECORDER)))
      .expect(204);
  });

  it.each([
    [500, '{"recorderId":"' + RECORDER + '"}'],
    [403, '{"recorderId":"' + RECORDER + '"}'],
    [204, ''],
    [200, 'not-json'],
    [200, '{}'],
    [200, 'null'],
    [200, '[{"recorderId":"' + RECORDER + '"}]'],
    [200, '{"recorderId":42}'],
    [200, '{"recorderId":"------------------------------------"}'],
  ])(
    'does not grant a recorder from an invalid response (%s, %s)',
    async (status, body) => {
      settingsStatus = status;
      settingsBody = body;
      await request(app.getHttpServer())
        .get(api(settings()))
        .responseType('blob')
        .expect(status);
      await request(app.getHttpServer()).post(api(subscription())).expect(403);
      expect(stored).not.toHaveProperty('amppRecorderIdsByWorkload');
    },
  );

  it('does not learn IDs from a browser settings POST or an unrelated GET', async () => {
    await request(app.getHttpServer())
      .post(api(settings()))
      .send({ recorderId: RECORDER })
      .expect(200);
    await request(app.getHttpServer())
      .get(api(settings().replace('recordingsettings', 'recorderinfo')))
      .expect(200);
    await request(app.getHttpServer()).post(api(subscription())).expect(403);
  });

  it('retains workload, context, topic and mailbox boundaries', async () => {
    await request(app.getHttpServer()).get(api(settings())).expect(200);
    upstream.mockClear();
    for (const url of [
      api(subscription(OTHER_RECORDER)),
      api(subscription(), OTHER),
      api(subscription(), DENIED),
      api(subscription(RECORDER, 'subscribe', 'unknown-mailbox')),
      api(subscription().replace(RECORDER, '*')),
      api(subscription().replace(RECORDER, '%23')),
      api(subscription() + '?extra=1'),
    ])
      await request(app.getHttpServer()).post(url).expect(403);
    await request(app.getHttpServer())
      .get(api(settings(DENIED)))
      .expect(403);
    await request(app.getHttpServer()).get(api(subscription())).expect(403);
    await request(app.getHttpServer()).put(api(subscription())).expect(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('attributes settings to the actual upstream workload rather than its route context', async () => {
    await request(app.getHttpServer())
      .get(api(settings(OTHER)))
      .expect(200);
    expect(stored).toMatchObject({
      amppRecorderIdsByWorkload: { [OTHER]: RECORDER },
    });
    await request(app.getHttpServer()).post(api(subscription())).expect(403);
    await request(app.getHttpServer())
      .post(api(subscription(), OTHER))
      .expect(204);
  });

  it('keeps existing workload and global notification subscriptions allowed', async () => {
    for (const topic of [
      'gv.platform.identity.permissions',
      `gv.ampp.workload.${WORKLOAD}.roundtriptest`,
    ]) {
      await request(app.getHttpServer())
        .post(
          api(
            subscription().replace(`gv.fabric.recorder.${RECORDER}.%23`, topic),
          ),
        )
        .expect(204);
    }
  });

  it('does not persist a recorder learned while permissions were revoked', async () => {
    revokeOnRead = true;
    await request(app.getHttpServer()).get(api(settings())).expect(200);
    expect(stored).not.toHaveProperty('amppRecorderIdsByWorkload');
    await request(app.getHttpServer()).post(api(subscription())).expect(403);
  });

  it('merges associations loaded concurrently by independent recorder tabs', async () => {
    let started = 0;
    let release: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    upstream.mockImplementation(async (_jar, path) => {
      if (++started === 2) release();
      await bothStarted;
      return {
        url: ORIGIN + path,
        status: 200,
        headers: {},
        body: Buffer.from(
          JSON.stringify({
            recorderId: path === settings() ? RECORDER : OTHER_RECORDER,
          }),
        ),
      };
    });
    await Promise.all(
      [WORKLOAD, OTHER].map((id) =>
        request(app.getHttpServer())
          .get(api(settings(id), id))
          .expect(200),
      ),
    );
    expect(stored).toMatchObject({
      amppRecorderIdsByWorkload: {
        [WORKLOAD]: RECORDER,
        [OTHER]: OTHER_RECORDER,
      },
    });
  });
});
