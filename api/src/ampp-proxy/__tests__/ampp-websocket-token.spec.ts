import { ConfigService } from '@nestjs/config';
import type { SessionData } from 'express-session';
import { AmppBearerTokenService } from '../ampp-bearer-token.service';
import { AmppWebSocketProxyService } from '../ampp-websocket-proxy.service';
import { storeAmppAccessToken } from '../ampp-access-tokens';
import { amppToken, cachedAmppToken } from './helpers/ampp-token';

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
  });
  async function connect() {
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
      peer(browserEvents),
      { session, headers: {} },
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
});
