import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { raw, type NextFunction, type Request, type Response } from 'express';
import type { SessionData } from 'express-session';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AuthService } from '../src/auth/auth.service';
import { AmppApiProxyController } from '../src/ampp-proxy/ampp-api-proxy.controller';
import type { AmppBearerTokenService } from '../src/ampp-proxy/ampp-bearer-token.service';
import type { AmppCookieHttpService } from '../src/ampp-proxy/ampp-cookie-http.service';
import { AmppDashboardFilterService } from '../src/ampp-proxy/ampp-dashboard-filter.service';
import { AmppMatrixFilterService } from '../src/ampp-proxy/ampp-matrix-filter.service';
import { AmppProxyPolicyService } from '../src/ampp-proxy/ampp-proxy-policy.service';
import { AmppProxyService } from '../src/ampp-proxy/ampp-proxy.service';
import { AmppProxySessionService } from '../src/ampp-proxy/ampp-proxy-session.service';
import { AmppResponseRewriterService } from '../src/ampp-proxy/ampp-response-rewriter.service';
import { GvuiProxyService } from '../src/ampp-proxy/gvui/gvui-proxy.service';

const W = '2e74ea96-1ec3-4a93-98a4-baa717055bcb';
const R = 'de712c28-4138-487f-9e7a-817d27a15f9d';
const C = 'a7a2108f-cdab-4240-8e4b-433adf60ace2';
const P = '38ad2cd0-654f-4b76-a622-8739017b9ffe';
const OLD = 'c9ee7a49-1f5f-46df-b2e7-8b2ba079939f';
const PW = '127650ae-fab8-4604-b341-36e71451bd05';
const F = '24319621-6be3-411c-923f-a12c2b1eca48';
const REQUEST = '55555555-5555-4555-8555-555555555555';
const ORIGIN = 'https://ampp.invalid';
const APP = `/mocha/application/${W}/api/v1/app`;
const MATRIX = '/cluster/matrix/api/v1';
const ROUTING = `${MATRIX}/routing`;
const DEST = `${ROUTING}/destination/${C}`;
const api = (path: string) => `/api/ampp-proxy/api/${W}${path}`;

// The transport models the supplied HAR's bug: changing the app's source does
// not change the recorder consumer. Only an explicit matrix route changes it.
// Guard, policy, controller, proxy, filters and session merge remain real.
describe('Clip Recorder input routing over HTTP', () => {
  let app: INestApplication<App>;
  let stored: SessionData | null;
  let upstream: jest.MockedFunction<AmppCookieHttpService['request']>;
  let route: string;
  let locked: boolean;
  let state: string;
  let prepareState: number;
  let prepareStatus: number;
  let resetOnPrepare: boolean;
  let pending: boolean;
  let routeError: string;
  let producers: unknown[];
  let consumers: unknown[];
  let binding: string;
  let calls: string[];
  let failures: Record<string, number>;
  let onRoute: () => void | Promise<void>;
  let onPrepare: () => void;
  let clearSessionToken: jest.Mock;

  beforeEach(async () => {
    route = OLD;
    locked = true;
    state = 'ready';
    prepareState = 5;
    prepareStatus = 200;
    resetOnPrepare = pending = false;
    routeError = '';
    binding = R;
    calls = [];
    failures = {};
    onRoute = () => {};
    onPrepare = () => {};
    producers = [
      {
        producer: {
          id: P,
          name: 'MiniMix Preview',
          workloadId: PW,
          fabricId: F,
          enabled: true,
        },
      },
    ];
    consumers = [
      {
        consumer: {
          id: C,
          name: 'Recorder input',
          workloadId: R,
          fabricId: F,
          enabled: true,
        },
      },
    ];
    stored = {
      user: { id: 'test-user' },
      authorizationFingerprint: 'granted',
      allowedWorkloads: [
        {
          id: W,
          name: 'Recorder',
          pageType: 'ampp-ui',
          is_parent: 0,
          packageName: 'GV.AMPP.Apps.Recorder',
          fabricId: F,
        },
      ],
      amppAllowedWorkloadIds: [W],
      // The source's UI is denied; existing background-source visibility allows it.
      amppResourceWorkloadIds: [W, PW],
    } as SessionData;
    const config = new ConfigService({
      PLATFORM_URL: ORIGIN,
      AMPP_RECORDER_ROUTE_TIMEOUT_MS: 100,
      AMPP_RECORDER_OPERATION_TIMEOUT_MS: 2000,
    });
    const matrix = new AmppMatrixFilterService(config);
    const gvui = new GvuiProxyService(config, {} as never);
    clearSessionToken = jest.fn((session: SessionData) => {
      delete session.amppAccessToken;
    });
    const response = (path: string, status: number, value: unknown) => ({
      url: ORIGIN + path,
      status,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(value === undefined ? '' : JSON.stringify(value)),
    });
    upstream = jest.fn(async (_jar, path, options = {}) => {
      const method = options.method ?? 'GET';
      const key = `${method} ${path.split('?')[0]}`;
      calls.push(key);
      if (failures[key])
        return response(path, failures[key], {
          message: 'AMPP fixture failure',
        });
      if (path === `${APP}/recordingsettings` && method === 'GET')
        return response(path, 200, {
          recorderId: binding,
          source: 'MiniMix Preview',
          profile: 'test.xml',
        });
      if (path === `${APP}/recorderinfo`) return response(path, 200, { state });
      if (path.startsWith(`${MATRIX}/producers?`))
        return response(path, 200, { producers });
      if (path.startsWith(`${MATRIX}/consumers?`))
        return response(path, 200, { consumers });
      if (path === DEST)
        return response(path, 200, {
          id: C,
          fabricId: F,
          sourceId: route,
          locked,
        });
      if (path === `${DEST}/unlock`) {
        locked = false;
        return response(path, 204, undefined);
      }
      if (path === `${DEST}/lock`) {
        locked = true;
        return response(path, 204, undefined);
      }
      if (path === `${ROUTING}/requestroute`) {
        const data = JSON.parse(String(options.data)) as {
          sourceId: string;
          destinationId: string;
        };
        expect(data).toEqual({ sourceId: P, destinationId: C });
        if (!pending) route = P;
        await onRoute();
        return response(path, 200, { requestId: REQUEST });
      }
      if (path === `${ROUTING}/routestatus/${REQUEST}`)
        return response(path, 200, {
          routeStatus: pending ? 'Pending' : 'Complete',
          routeErrorMessage: routeError,
        });
      if (path === `${APP}/preparerecording`) {
        onPrepare();
        if (resetOnPrepare) route = OLD;
        return response(
          path,
          prepareStatus,
          prepareStatus === 200
            ? { state: prepareState }
            : { message: 'Native prepare failed' },
        );
      }
      if (path === `${APP}/recordingsettings`)
        return response(path, 200, {
          recorderId: R,
          source: 'MiniMix Preview',
        });
      if (path === `${APP}/startrecording` || path === `${APP}/stoprecording`)
        return response(path, 204, undefined);
      throw new Error(`Unexpected upstream request: ${key}`);
    });
    const proxy = new AmppProxyService(
      config,
      {
        getSessionToken: () => 'test-token',
        clearSessionToken,
      } as unknown as AmppBearerTokenService,
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
      req.sessionID = 'routing-session';
      req.session = Object.assign(structuredClone(stored), {
        touch: () => {},
        save: (done: () => void) => {
          stored = JSON.parse(JSON.stringify(req.session)) as SessionData;
          done();
        },
      }) as Request['session'];
      req.sessionStore = {
        get: (_id: string, done: (e: null, s: SessionData | null) => void) =>
          done(null, structuredClone(stored)),
      } as never;
      next();
    });
    await app.init();
  });
  afterEach(async () => app.close());
  const prepare = () =>
    request(app.getHttpServer())
      .post(api(`${APP}/preparerecording`))
      .send({ state: 0 });

  it('routes the selected producer, restores the lock, then prepares and verifies', async () => {
    await prepare().expect(200, { state: 5 });
    expect(route).toBe(P);
    expect(locked).toBe(true);
    expect(calls.indexOf(`POST ${ROUTING}/requestroute`)).toBeLessThan(
      calls.indexOf(`POST ${APP}/preparerecording`),
    );
    expect(
      calls.filter((c) => c === `GET ${DEST}`).length,
    ).toBeGreaterThanOrEqual(3);
  });
  it('isolates internal lookups from browser conditional and service-instance headers', async () => {
    await prepare()
      .set('If-None-Match', 'stale-validator')
      .set('If-Match', 'browser-version')
      .set('X-Service-Instance', OLD)
      .expect(200);
    const lookup = upstream.mock.calls.find(
      ([, path, options]) =>
        path === `${APP}/recordingsettings` && options?.method === 'GET',
    );
    expect(lookup?.[2]?.headers).not.toHaveProperty('If-None-Match');
    expect(lookup?.[2]?.headers).not.toHaveProperty('If-Match');
    expect(lookup?.[2]?.headers).not.toHaveProperty('X-Service-Instance');
    expect(lookup?.[2]?.headers).toHaveProperty(
      'Authorization',
      'Bearer test-token',
    );
  });
  it('keeps an originally unlocked destination unlocked', async () => {
    locked = false;
    await prepare().expect(200);
    expect(route).toBe(P);
    expect(locked).toBe(false);
    expect(calls).not.toContain(`POST ${DEST}/lock`);
  });
  it('does not alter a route that is already correct', async () => {
    route = P;
    await prepare().expect(200);
    expect(calls).not.toContain(`POST ${DEST}/unlock`);
    expect(calls).not.toContain(`POST ${ROUTING}/requestroute`);
  });
  it('refuses Start if the input changed after preparation', async () => {
    state = 'prepared';
    await request(app.getHttpServer())
      .get(api(`${APP}/startrecording`))
      .expect(409);
    expect(calls).not.toContain(`GET ${APP}/startrecording`);
    expect(calls).not.toContain(`POST ${ROUTING}/requestroute`);
  });
  it('verifies a correct input immediately before Start', async () => {
    state = 'prepared';
    route = P;
    await request(app.getHttpServer())
      .get(api(`${APP}/startrecording`))
      .expect(204);
    expect(calls).toContain(`GET ${DEST}`);
  });
  it('refuses a prepared result when AMPP reset the route', async () => {
    resetOnPrepare = true;
    await prepare().expect(409);
    expect(locked).toBe(true);
  });
  it('refuses a prepared result when the native recorder binding changed', async () => {
    onPrepare = () => {
      binding = OLD;
    };
    await prepare().expect(409);
    expect(locked).toBe(true);
  });
  it('rejects preparation while the recorder is running', async () => {
    state = 'started';
    await prepare().expect(409);
    expect(calls).not.toContain(`POST ${APP}/preparerecording`);
  });
  it('rejects a source outside background resource visibility', async () => {
    stored.amppResourceWorkloadIds = [W];
    await prepare().expect(403);
    expect(calls).not.toContain(`POST ${DEST}/unlock`);
  });
  it('rejects a settings POST that attempts to retarget the recorder binding', async () => {
    await request(app.getHttpServer())
      .post(api(`${APP}/recordingsettings`))
      .send({ recorderId: OLD, source: 'MiniMix Preview' })
      .expect(403);
    expect(calls).not.toContain(`POST ${APP}/recordingsettings`);
  });
  it('rejects an invalid trusted recorder ID', async () => {
    binding = 'invalid';
    await prepare().expect(502);
  });
  it('rejects a destination belonging to another engine', async () => {
    consumers = [
      { consumer: { id: C, workloadId: OLD, fabricId: F, enabled: true } },
    ];
    await prepare().expect(409);
    expect(calls).not.toContain(`POST ${DEST}/unlock`);
  });
  it('rejects ambiguous recorder destinations', async () => {
    consumers.push({
      consumer: { id: OLD, workloadId: R, fabricId: F, enabled: true },
    });
    await prepare().expect(409);
  });
  it('rejects ambiguous source names', async () => {
    producers.push({
      producer: {
        id: OLD,
        name: 'MiniMix Preview',
        workloadId: PW,
        fabricId: F,
        enabled: true,
      },
    });
    await prepare().expect(409);
  });
  it.each([
    `${DEST}/unlock`,
    `${ROUTING}/requestroute`,
    `${ROUTING}/routestatus/${REQUEST}`,
  ])('attempts relocking after a failed %s', async (path) => {
    failures[`${path.includes('routestatus') ? 'GET' : 'POST'} ${path}`] = 500;
    await prepare().expect(502);
    expect(calls).toContain(`POST ${DEST}/lock`);
    expect(calls).not.toContain(`POST ${APP}/preparerecording`);
  });
  it('refuses preparation if the original lock cannot be restored', async () => {
    failures[`POST ${DEST}/lock`] = 500;
    await prepare().expect(502);
    expect(calls).not.toContain(`POST ${APP}/preparerecording`);
  });
  it('bounds a pending route and restores its lock', async () => {
    pending = true;
    await prepare().expect(504);
    expect(locked).toBe(true);
    expect(calls).not.toContain(`POST ${APP}/preparerecording`);
  });
  it('bounds an unresponsive route request and restores its lock', async () => {
    onRoute = () => new Promise<void>(() => {});
    await prepare().expect(504);
    expect(locked).toBe(true);
    expect(calls).not.toContain(`POST ${APP}/preparerecording`);
  });
  it('cancels a disconnected caller and restores the lock before accepting another operation', async () => {
    let entered: () => void;
    let release: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    onRoute = async () => {
      entered();
      await gate;
    };
    const attempt = prepare();
    const finished = attempt.then(
      () => {},
      () => {},
    );
    try {
      await started;
      attempt.abort();
      for (let i = 0; i < 100 && !calls.includes(`POST ${DEST}/lock`); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(locked).toBe(true);
      expect(calls).not.toContain(`POST ${APP}/preparerecording`);
    } finally {
      release();
      await finished;
    }
    onRoute = () => {};
    await prepare().expect(200);
  });
  it('reports a route error and restores its lock', async () => {
    routeError = 'AMPP refused this route';
    await prepare().expect(409);
    expect(locked).toBe(true);
  });
  it('rechecks stored authorization during the workflow and still restores the lock', async () => {
    onRoute = () => {
      stored.authorizationFingerprint = 'revoked';
    };
    await prepare().expect(403);
    expect(locked).toBe(true);
    expect(calls).not.toContain(`POST ${APP}/preparerecording`);
  });
  it('stops after logout during routing without recreating the session', async () => {
    onRoute = () => {
      stored = null;
    };
    await prepare().expect(401);
    expect(locked).toBe(true);
    expect(stored).toBeNull();
    expect(calls).not.toContain(`POST ${APP}/preparerecording`);
  });
  it('persists token invalidation after an internal authentication failure', async () => {
    stored.amppAccessToken = 'expired-token';
    failures[`GET ${APP}/recordingsettings`] = 401;
    await prepare().expect(502);
    expect(clearSessionToken).toHaveBeenCalled();
    expect(stored.amppAccessToken).toBeUndefined();
  });
  it('rejects overlapping preparation of the same recorder', async () => {
    let release: () => void;
    let started: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    onRoute = async () => {
      started();
      await wait;
    };
    const first = prepare().then((res) => res);
    try {
      await entered;
      await prepare().expect(409);
    } finally {
      release();
    }
    expect((await first).status).toBe(200);
    expect(
      calls.filter((c) => c === `POST ${APP}/preparerecording`),
    ).toHaveLength(1);
  }, 5000);
  it('preserves native overwrite confirmation and error responses', async () => {
    prepareState = 3;
    await prepare().expect(200, { state: 3 });
    prepareStatus = 500;
    await prepare().expect(500, { message: 'Native prepare failed' });
  });
  it('preserves the overwrite confirmation command after verifying the input', async () => {
    await request(app.getHttpServer())
      .post(api(`${APP}/preparerecording`))
      .send({ state: 4 })
      .expect(200, { state: 5 });
    expect(route).toBe(P);
    expect(
      upstream.mock.calls
        .find(
          ([, path, options]) =>
            path === `${APP}/preparerecording` && options?.method === 'POST',
        )?.[2]
        ?.data?.toString(),
    ).toBe(JSON.stringify({ state: 4 }));
  });
  it('rejects a source-settings change during recording', async () => {
    state = 'started';
    await request(app.getHttpServer())
      .post(api(`${APP}/recordingsettings`))
      .send({ recorderId: R, source: 'MiniMix Preview' })
      .expect(409);
    expect(calls).not.toContain(`POST ${APP}/recordingsettings`);
  });
  it('preserves clearing the source without creating a route', async () => {
    await request(app.getHttpServer())
      .post(api(`${APP}/recordingsettings`))
      .send({ recorderId: R, source: '' })
      .expect(200);
    expect(calls).not.toContain(`POST ${ROUTING}/requestroute`);
  });
  it('rejects malformed source settings', async () => {
    await request(app.getHttpServer())
      .post(api(`${APP}/recordingsettings`))
      .set('Content-Type', 'application/json')
      .send('{bad json')
      .expect(400);
    expect(calls).not.toContain(`POST ${APP}/recordingsettings`);
  });
  it('cannot bypass input verification with a query or alternate method', async () => {
    await request(app.getHttpServer())
      .get(api(`${APP}/startrecording?bypass=1`))
      .expect(403);
    await request(app.getHttpServer())
      .post(api(`${APP}/startrecording`))
      .expect(403);
    await request(app.getHttpServer())
      .get(api(`${APP}/preparerecording`))
      .expect(403);
    expect(calls).toEqual([]);
  });
  it('also checks an encoded Start path', async () => {
    state = 'prepared';
    await request(app.getHttpServer())
      .get(api(`${APP}/%73tartrecording`))
      .expect(409);
    expect(calls).not.toContain(`GET ${APP}/%73tartrecording`);
  });
  it('keeps Stop independent of routing metadata and failures', async () => {
    failures[`GET ${APP}/recordingsettings`] = 500;
    await request(app.getHttpServer())
      .get(api(`${APP}/stoprecording`))
      .expect(204);
    expect(calls).toEqual([`GET ${APP}/stoprecording`]);
  });
  it('keeps direct matrix route and lock requests forbidden', async () => {
    await request(app.getHttpServer())
      .post(api(`${ROUTING}/requestroute`))
      .send({ sourceId: P, destinationId: C })
      .expect(403);
    await request(app.getHttpServer())
      .post(api(`${DEST}/unlock`))
      .expect(403);
    expect(upstream).not.toHaveBeenCalled();
  });
});
