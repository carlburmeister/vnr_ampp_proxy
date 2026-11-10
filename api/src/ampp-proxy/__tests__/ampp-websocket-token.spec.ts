import { ConfigService } from '@nestjs/config';
import type { SessionData } from 'express-session';
import { AmppBearerTokenService } from '../ampp-bearer-token.service';
import { AmppWebSocketProxyService } from '../ampp-websocket-proxy.service';
import { storeAmppAccessToken } from '../ampp-access-tokens';
import { amppToken, cachedAmppToken } from './helpers/ampp-token';
// TEMP AMPP trace: remove with diagnostics/ampp-proxy-trace.ts.
import { traceUpgrade } from '../diagnostics/ampp-proxy-trace';
import {
  MysqlSessionStore,
  SessionExpiredError,
} from '../../auth/mysql-session.store';

jest.mock('ws', () =>
  Object.assign(jest.fn(), {
    OPEN: 1,
    CONNECTING: 0,
    Server: jest.fn(() => ({ close: jest.fn() })),
  }),
);

type Peer = {
  on: (event: string, callback: (...args: unknown[]) => void) => Peer;
  close: jest.Mock;
  terminate: jest.Mock;
};

describe('Notification WebSocket bearer selection', () => {
  let service: AmppWebSocketProxyService;
  let bearer: AmppBearerTokenService;
  let session: SessionData;
  let upstreamEvents: Map<string, (...args: unknown[]) => void>;
  let browserEvents: Map<string, (...args: unknown[]) => void>;
  const Socket =
    jest.requireMock<
      jest.Mock<
        Peer,
        [string, string[] | undefined, { headers: Record<string, string> }]
      >
    >('ws');
  function peer(events: Map<string, (...args: unknown[]) => void>): Peer {
    const value: Peer = {
      on: (event, callback) => {
        events.set(event, callback);
        return value;
      },
      close: jest.fn(),
      terminate: jest.fn(),
    };
    return value;
  }
  beforeEach(() => {
    session = {} as SessionData;
    browserEvents = new Map();
    upstreamEvents = new Map();
    Socket.mockReset().mockImplementation(() => peer(upstreamEvents));
    const config = new ConfigService({ PLATFORM_URL: 'https://ampp.invalid' });
    bearer = new AmppBearerTokenService(config);
    service = new AmppWebSocketProxyService(
      config,
      bearer,
      {} as never,
      {} as never,
      {} as never,
    );
  });
  afterEach(() => {
    browserEvents.get('close')?.(1000, '');
    service.onModuleDestroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });
  async function connect(
    request: unknown = { session, headers: {} },
    browser = peer(browserEvents),
  ) {
    await (
      service as unknown as {
        connectUpstream: (
          browser: Peer,
          request: unknown,
          workload: string,
          path: string,
        ) => Promise<void>;
      }
    ).connectUpstream(
      browser,
      request,
      'workload',
      '/pushnotificationshub',
    );
  }

  it('uses a platform token and invalidates only that token after upstream 401', async () => {
    const wrapper = amppToken('wrapper');
    const gvui = amppToken('gvui', ['platform']);
    storeAmppAccessToken(session, wrapper);
    storeAmppAccessToken(session, gvui);
    await connect();
    expect(Socket.mock.lastCall[2].headers.Authorization).toBe(
      'Bearer ' + gvui,
    );
    expect(
      new URL(Socket.mock.lastCall[0]).searchParams.get('access_token'),
    ).toBe(gvui);
    upstreamEvents.get('unexpected-response')(undefined, {
      statusCode: 401,
      resume: () => {},
    });
    expect(cachedAmppToken(session, 'gvui')).toBeUndefined();
    expect(cachedAmppToken(session, 'wrapper').token).toBe(wrapper);
  });

  function contactRequest() {
    session.user = { id: '42' } as never;
    const recordContact = jest
      .fn<Promise<void>, [string, SessionData]>()
      .mockResolvedValue(undefined);
    const store = Object.assign(
      Object.create(MysqlSessionStore.prototype) as MysqlSessionStore,
      {
        recordContact,
        recordActivity: jest.fn(),
        get: jest.fn(
          (
            _sid: string,
            done: (error: Error | null, data: SessionData) => void,
          ) => done(null, session),
        ),
      },
    );
    return { session, sessionID: 'sid', sessionStore: store, headers: {} };
  }

  it('records validated upgrades and maps expiry to HTTP 401', async () => {
    const req = contactRequest();
    const internals = service as unknown as {
      loadSession: (request: unknown) => Promise<void>;
      authorizeUpgrade: (
        request: unknown,
        parsed: { workloadId: string; upstreamPath: string },
      ) => Promise<string>;
    };
    jest.spyOn(internals, 'loadSession').mockResolvedValue(undefined);
    Object.assign(service, {
      auth: { refreshSessionAuthorization: jest.fn().mockResolvedValue(false) },
      policy: {
        assertWebSocketAccess: jest
          .fn()
          .mockReturnValue('/pushnotificationshub'),
      },
    });
    const authorize = () =>
      internals.authorizeUpgrade(req, {
        workloadId: 'workload',
        upstreamPath: '/pushnotificationshub',
      });
    await expect(authorize()).resolves.toBe('/pushnotificationshub');
    expect(req.sessionStore.recordContact).toHaveBeenCalledWith('sid', session);
    req.sessionStore.recordContact.mockRejectedValueOnce(
      new SessionExpiredError(),
    );
    await expect(authorize()).rejects.toMatchObject({ status: 401 });
  });

  it('records browser messages without treating permission timers or upstream notifications as contact', async () => {
    jest.useFakeTimers();
    const req = contactRequest();
    Object.assign(service, {
      auth: { refreshSessionAuthorization: jest.fn().mockResolvedValue(false) },
      policy: { assertWebSocketAccess: jest.fn() },
    });
    storeAmppAccessToken(session, amppToken('wrapper'));
    await connect(req);
    await jest.advanceTimersByTimeAsync(10000);
    upstreamEvents.get('message')?.('notification');
    expect(req.sessionStore.recordContact).not.toHaveBeenCalled();
    browserEvents.get('message')?.('browser-message');
    await Promise.resolve();
    expect(req.sessionStore.recordContact).toHaveBeenCalledTimes(1);
    expect(req.sessionStore.recordContact).toHaveBeenCalledWith('sid', session);
    expect(req.sessionStore.recordActivity).not.toHaveBeenCalled();
  });

  it('uses the existing fallback instead of a read-only notification token', async () => {
    storeAmppAccessToken(session, amppToken('reader', ['platform.readonly']));
    const fallback = jest
      .spyOn(bearer, 'getToken')
      .mockResolvedValue('fallback');
    await connect();
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(Socket.mock.lastCall[2].headers.Authorization).toBe(
      'Bearer fallback',
    );
  });

  it('preserves tokens after a genuine upstream 403', async () => {
    storeAmppAccessToken(session, amppToken('wrapper'));
    const before = JSON.stringify(session.amppAccessTokens);
    const invalidate = jest.spyOn(bearer, 'invalidate');
    await connect();
    upstreamEvents.get('unexpected-response')(undefined, {
      statusCode: 403,
      resume: () => {},
    });
    expect(JSON.stringify(session.amppAccessTokens)).toBe(before);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('correlates upstream/browser closure while preserving peer close propagation', async () => {
    const before = process.env.AMPP_PROXY_TRACE;
    process.env.AMPP_PROXY_TRACE = 'true';
    const lines: string[] = [];
    const sink = jest
      .spyOn(console, 'info')
      .mockImplementation((line: string) => lines.push(line));
    try {
      storeAmppAccessToken(session, amppToken('wrapper'));
      const req = {
        session,
        headers: {},
        method: 'GET',
        url: '/api/ampp-proxy/ws/workload/pushnotificationshub?access_token=TOKEN_SECRET',
      };
      const browser = Object.assign(peer(browserEvents), { readyState: 1 });
      let connected: Promise<void>;
      traceUpgrade(req as never, () => {
        connected = connect(req, browser);
      });
      await connected;
      upstreamEvents.get('close')(1000, 'PRIVATE_REASON');
      expect(browser.close).toHaveBeenCalledWith(1000, 'PRIVATE_REASON');
      browserEvents.get('close')(1000, 'PRIVATE_REASON');
      const rows = lines.map(
        (line) =>
          JSON.parse(line.slice('[AMPP proxy trace] '.length)) as Record<
            string,
            unknown
          >,
      );
      const closed = rows.filter((row) => row.event === 'websocket.close');
      expect(closed.map((row) => row.side)).toEqual(['upstream', 'browser']);
      expect(closed.every((row) => row.initiator === 'upstream')).toBe(true);
      expect(new Set(rows.map((row) => row.traceId)).size).toBe(1);
      expect(JSON.stringify(rows)).not.toMatch(/PRIVATE_REASON|TOKEN_SECRET/);
    } finally {
      sink.mockRestore();
      if (before === undefined) delete process.env.AMPP_PROXY_TRACE;
      else process.env.AMPP_PROXY_TRACE = before;
    }
  });
});
