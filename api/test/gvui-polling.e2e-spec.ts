import { BadGatewayException, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import { raw } from 'express';
import type { SessionData } from 'express-session';
import { request as httpRequest, type Server } from 'node:http';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AuthService } from '../src/auth/auth.service';
import { AmppApiProxyController } from '../src/ampp-proxy/ampp-api-proxy.controller';
import { AmppMatrixFilterService } from '../src/ampp-proxy/ampp-matrix-filter.service';
import { AmppProxyPolicyService } from '../src/ampp-proxy/ampp-proxy-policy.service';
import { AmppProxyService } from '../src/ampp-proxy/ampp-proxy.service';
import { AmppProxySessionService } from '../src/ampp-proxy/ampp-proxy-session.service';
import { GvuiProxyService } from '../src/ampp-proxy/gvui/gvui-proxy.service';
// TEMP AMPP trace: exercises the optional middleware through the existing real guard/controller.
import {
  amppTraceMiddleware,
  traceSessionStore,
} from '../src/ampp-proxy/diagnostics/ampp-proxy-trace';

const LAYOUT = '11111111-1111-4111-8111-111111111111';
const WORKLOAD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ALIAS = 'ts-gvui--dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CONTEXT = `gvui-${LAYOUT}`;
const ORIGIN = 'https://ampp.invalid';
const POLL = `/api/ampp-proxy/api/${CONTEXT}/notifications/api/v1/notifications/${ALIAS}?count=100&timeout=10000`;

// Real guard/policy/controller/session merge, with a controllable AMPP transport
// and an in-memory persistent store. No credentials, live AMPP or MySQL needed.
describe('GVUI polling lifecycle over HTTP', () => {
  let app: INestApplication<App>;
  let stored: SessionData;
  let status: number;
  let saves: number;
  let revokeOnRead: boolean;
  let lastResponse: Response;
  let upstream: jest.MockedFunction<AmppProxyService['proxyApiRequest']>;

  beforeEach(async () => {
    status = 200;
    saves = 0;
    revokeOnRead = false;
    const config = new ConfigService({ PLATFORM_URL: ORIGIN });
    const gvui = new GvuiProxyService(config, {
      getGvuiConfigurations: () =>
        Promise.resolve([
          {
            configuration: {
              key: `gv-ui-l/${LAYOUT}`,
              value: JSON.stringify({
                id: LAYOUT,
                components: [
                  {
                    type: 'web',
                    url: `${ORIGIN}/app/wrapper/embedded/single/Test/${WORKLOAD}`,
                  },
                ],
              }),
            },
          },
        ]),
    } as never);
    stored = {
      cookie: {},
      user: { id: 'test-user' },
      authorizationFingerprint: 'granted',
      allowedGvuiLayoutIds: [LAYOUT],
      allowedGvuiLayouts: [
        { id: LAYOUT, name: 'Layout', associatedWorkloadId: null },
      ],
      allowedWorkloads: [
        {
          id: WORKLOAD,
          name: 'Test',
          packageName: 'Test',
          pageType: 'ampp-ui',
          is_parent: 0,
        },
      ],
      amppAllowedWorkloadIds: [WORKLOAD],
      amppNotificationMailboxIds: ['ordinary-mailbox'],
    } as SessionData;
    await gvui.launch(stored, LAYOUT);
    stored.gvuiMailboxes = {
      [ALIAS]: {
        contextId: CONTEXT,
        upstreamId: 'private-upstream',
        createdAt: 1,
        lastUsedAt: Date.now() - 120000,
      },
    };
    upstream = jest.fn<
      ReturnType<AmppProxyService['proxyApiRequest']>,
      Parameters<AmppProxyService['proxyApiRequest']>
    >();
    upstream.mockImplementation(
      (_sid, session, context, method, path, _headers, body) => {
        const prepared = gvui.prepareApiRequest(
          session,
          context,
          method,
          path,
          body,
        );
        const result = gvui.completeApiRequest(session, context, prepared, {
          url: ORIGIN + path,
          status,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from(
            JSON.stringify(
              prepared.mailbox ? { id: prepared.mailbox.upstreamId } : [],
            ),
          ),
        });
        return Promise.resolve({
          status: result.status,
          body: result.body,
          headers: {
            'content-type': 'application/json',
            'x-upstream-check': 'kept',
          },
        });
      },
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
          useValue: new AmppProxyPolicyService(
            new AmppMatrixFilterService(config),
            gvui,
          ),
        },
        { provide: AmppProxyService, useValue: { proxyApiRequest: upstream } },
        AmppProxySessionService,
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.use(amppTraceMiddleware);
    app.use(raw({ type: () => true }));
    app.use((req: Request, res: Response, next: NextFunction) => {
      lastResponse = res;
      req.sessionID = 'session-one';
      req.session = Object.assign(structuredClone(stored), {
        touch: () => {},
        save: (done: () => void) => {
          saves++;
          stored = JSON.parse(JSON.stringify(req.session)) as SessionData;
          done();
        },
      }) as Request['session'];
      req.sessionStore = {
        get: (
          _id: string,
          done: (error: null, session: SessionData) => void,
        ) => {
          if (revokeOnRead) {
            stored.authorizationFingerprint = 'revoked';
            stored.allowedGvuiLayoutIds = [];
            stored.allowedGvuiLayouts = [];
            stored.gvuiMailboxes = {};
          }
          done(null, structuredClone(stored));
        },
      } as never;
      traceSessionStore(req.sessionStore);
      next();
    });
    await app.init();
  });
  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  async function captureTrace(action: () => Promise<void>) {
    const before = process.env.AMPP_PROXY_TRACE;
    process.env.AMPP_PROXY_TRACE = 'true';
    const output: string[] = [];
    const sink = jest
      .spyOn(console, 'info')
      .mockImplementation((line: string) => output.push(line));
    try {
      await action();
      return output.map(
        (line) =>
          JSON.parse(line.slice('[AMPP proxy trace] '.length)) as Record<
            string,
            unknown
          >,
      );
    } finally {
      sink.mockRestore();
      if (before === undefined) delete process.env.AMPP_PROXY_TRACE;
      else process.env.AMPP_PROXY_TRACE = before;
    }
  }

  it('correlates real guard/policy/session/response stages without changing a successful poll', async () => {
    const rows = await captureTrace(async () => {
      await request(app.getHttpServer())
        .get(POLL)
        .expect(200)
        .expect('x-ampp-trace-id', /^[0-9a-f-]{36}$/);
    });
    const events = rows.map((row) => row.event);
    for (const event of [
      'request.received',
      'authorization.start',
      'authorization.end',
      'policy.start',
      'policy.end',
      'session.get.start',
      'session.get.end',
      'proxy.api.start',
      'proxy.api.end',
      'response.finish',
    ])
      expect(events).toContain(event);
    expect(new Set(rows.map((row) => row.traceId)).size).toBe(1);
    expect(rows.find((row) => row.event === 'response.finish').status).toBe(
      200,
    );
    expect(JSON.stringify(rows)).not.toContain('session-one');
  });

  it('records a local 403 and its delayed response without an upstream request', async () => {
    const rows = await captureTrace(async () => {
      await request(app.getHttpServer())
        .get(POLL.replace(ALIAS, 'unknown-mailbox'))
        .expect(403);
    });
    expect(rows.find((row) => row.event === 'policy.error')).toMatchObject({
      status: 403,
    });
    expect(rows.find((row) => row.event === 'poll.delay.start')).toMatchObject({
      status: 403,
      delayMs: expect.any(Number) as unknown,
    });
    expect(
      rows.find((row) => row.event === 'poll.delay.end').durationMs,
    ).toBeGreaterThanOrEqual(750);
    expect(rows.find((row) => row.event === 'response.finish')).toMatchObject({
      status: 403,
    });
    expect(rows.some((row) => row.event === 'proxy.api.start')).toBe(false);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('persists activity before the upstream poll and throttles subsequent activity writes', async () => {
    const original = upstream.getMockImplementation();
    upstream.mockImplementation((...args) => {
      expect(stored.gvuiMailboxes[ALIAS].lastUsedAt).toBeGreaterThan(
        Date.now() - 60000,
      );
      return original(...args);
    });
    await request(app.getHttpServer())
      .get(POLL)
      .expect(200)
      .expect('x-upstream-check', 'kept');
    expect(saves).toBe(1);
    await request(app.getHttpServer()).get(POLL).expect(200);
    expect(saves).toBe(1);
  });

  it('delivers 404 immediately, allows same-ID recreation, and resumes polling', async () => {
    status = 404;
    const start = Date.now();
    await request(app.getHttpServer()).get(POLL).expect(404);
    expect(Date.now() - start).toBeLessThan(500);
    status = 200;
    const created = await request(app.getHttpServer())
      .post(`/api/ampp-proxy/api/${CONTEXT}/notifications/api/v1/mailbox`)
      .set('Content-Type', 'application/json')
      .send(
        JSON.stringify({
          id: ALIAS,
          durable: false,
          mailboxTTL: 1500000,
          maximumLength: 10000,
          subscription: 'gv',
        }),
      )
      .expect(200);
    expect((created.body as { id: string }).id).toBe(ALIAS);
    await request(app.getHttpServer()).get(POLL).expect(200);
  });

  it('paces an upstream 403 without changing its status, body or headers', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    status = 403;
    const start = Date.now();
    const result = await request(app.getHttpServer())
      .get(POLL)
      .expect(403)
      .expect('x-upstream-check', 'kept');
    expect(result.body).toEqual([]);
    expect(Date.now() - start).toBeGreaterThanOrEqual(950);
    status = 200;
    const recovered = Date.now();
    await request(app.getHttpServer()).get(POLL).expect(200);
    expect(Date.now() - recovered).toBeLessThan(500);
  });

  it('persists legacy grace on a full session, then reclaims it without creating orphan mailboxes', async () => {
    stored.gvuiMailboxes = Object.fromEntries(
      Array.from({ length: 512 }, (_, i) => [
        `legacy-${i}`,
        { contextId: CONTEXT, upstreamId: `upstream-${i}`, createdAt: 1 },
      ]),
    );
    const create = () =>
      request(app.getHttpServer())
        .post(`/api/ampp-proxy/api/${CONTEXT}/notifications/api/v1/mailbox`)
        .set('Content-Type', 'application/json')
        .send(
          JSON.stringify({
            id: ALIAS,
            durable: false,
            mailboxTTL: 1500000,
            maximumLength: 10000,
            subscription: 'gv',
          }),
        );
    await create().expect(409);
    expect(upstream).not.toHaveBeenCalled();
    const observedAt = stored.gvuiMailboxes['legacy-0'].lastUsedAt;
    expect(observedAt).toBeGreaterThan(Date.now() - 1000);
    jest.spyOn(Date, 'now').mockReturnValue(observedAt + 27 * 60000);
    await create().expect(200);
    expect(Object.keys(stored.gvuiMailboxes)).toEqual([ALIAS]);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('paces local policy rejection and does not call the upstream', async () => {
    const start = Date.now();
    await request(app.getHttpServer())
      .get(POLL.replace(ALIAS, 'unknown-mailbox'))
      .expect(403);
    expect(Date.now() - start).toBeGreaterThanOrEqual(750);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('rechecks grants after the activity save reloads a concurrent revocation', async () => {
    revokeOnRead = true;
    await request(app.getHttpServer()).get(POLL).expect(403);
    expect(upstream).not.toHaveBeenCalled();
    expect(saves).toBe(0);
  });

  it('does not pace ordinary workload notification errors', async () => {
    status = 403;
    const start = Date.now();
    await request(app.getHttpServer())
      .get(
        `/api/ampp-proxy/api/${WORKLOAD}/notifications/api/v1/notifications/ordinary-mailbox?count=100&timeout=10000`,
      )
      .expect(403);
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('preserves upstream transport errors while pacing the failed poll', async () => {
    upstream.mockRejectedValueOnce(
      new BadGatewayException('test transport error'),
    );
    const start = Date.now();
    const result = await request(app.getHttpServer()).get(POLL).expect(502);
    expect((result.body as { message: string }).message).toBe(
      'test transport error',
    );
    expect(Date.now() - start).toBeGreaterThanOrEqual(750);
  });

  it('releases a failed response when the client disconnects during pacing', async () => {
    status = 403;
    await app.listen(0, '127.0.0.1');
    const address = (app.getHttpServer() as Server).address();
    if (!address || typeof address === 'string')
      throw new Error('HTTP listener missing');
    const client = httpRequest({
      hostname: '127.0.0.1',
      port: address.port,
      path: POLL,
    });
    client.on('error', () => {});
    client.end();
    await new Promise<void>((resolve) => {
      const check = () => {
        if (upstream.mock.calls.length) resolve();
        else setTimeout(check, 5);
      };
      check();
    });
    const send = jest.spyOn(lastResponse, 'send');
    const closed = new Promise<void>((resolve) =>
      lastResponse.once('close', () => resolve()),
    );
    client.destroy();
    await closed;
    await new Promise((resolve) => setImmediate(resolve));
    expect(send).not.toHaveBeenCalled();
    expect(lastResponse.listenerCount('close')).toBe(0);
  });
});
