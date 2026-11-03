import { EventEmitter } from 'node:events';
import type { Request, Response, NextFunction } from 'express';
import type { Store } from 'express-session';
import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import type { CookieJar } from 'tough-cookie';
import { AmppCookieHttpService } from '../ampp-cookie-http.service';
import {
  amppTraceMiddleware,
  traceEvent,
  traceForRequest,
  traceMailbox,
  tracePath,
  tracePhase,
  traceSessionStore,
  traceSocketClose,
  traceUpgrade,
} from './ampp-proxy-trace';

const CONTEXT = 'gvui-11111111-1111-4111-8111-111111111111';
const PATH = `/api/ampp-proxy/api/${CONTEXT}/notifications/api/v1/notifications/private-alias?access_token=QUERY_SECRET`;

function requestScope<T>(
  action: (req: Request, res: Response) => T,
  path = PATH,
) {
  const req = Object.assign(new EventEmitter(), {
    method: 'GET',
    originalUrl: path,
    url: path,
    sessionID: 'SESSION_SECRET',
  }) as Request;
  const setHeader = jest.fn();
  const res = Object.assign(new EventEmitter(), {
    statusCode: 204,
    writableFinished: false,
    setHeader,
  }) as unknown as Response;
  let result: T;
  amppTraceMiddleware(req, res, (() => {
    result = action(req, res);
  }) as NextFunction);
  return { req, res, result, setHeader };
}

describe('temporary AMPP request tracing', () => {
  let info: jest.SpyInstance;
  let before: string | undefined;
  const records = () =>
    info.mock.calls.map(
      ([line]: [string]) =>
        JSON.parse(line.slice('[AMPP proxy trace] '.length)) as Record<
          string,
          unknown
        >,
    );

  beforeEach(() => {
    before = process.env.AMPP_PROXY_TRACE;
    delete process.env.AMPP_PROXY_TRACE;
    info = jest.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => {
    if (before === undefined) delete process.env.AMPP_PROXY_TRACE;
    else process.env.AMPP_PROXY_TRACE = before;
    jest.restoreAllMocks();
  });

  it('defaults off with unchanged promise/store methods and no headers/listeners/logging', () => {
    const get = jest.fn();
    const store = { get } as unknown as Store;
    traceSessionStore(store);
    const promise = Promise.resolve(204);
    const scope = requestScope(() => tracePhase('operation', () => promise));
    expect(scope.result).toBe(promise);
    expect(
      Object.getOwnPropertyDescriptor(store, 'get')?.value as unknown,
    ).toBe(get);
    expect(scope.setHeader).not.toHaveBeenCalled();
    expect(scope.res.listenerCount('finish')).toBe(0);
    expect(scope.req.listenerCount('aborted')).toBe(0);
    expect(info).not.toHaveBeenCalled();
  });

  it('ignores non-proxy routes even when enabled', () => {
    process.env.AMPP_PROXY_TRACE = 'true';
    const scope = requestScope(
      () => traceEvent('unexpected'),
      '/api/auth/login',
    );
    expect(scope.setHeader).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it('correlates concurrent requests and async stages independently', async () => {
    process.env.AMPP_PROXY_TRACE = 'true';
    let release: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = requestScope(() =>
      tracePhase('first', async () => {
        await paused;
        traceEvent('first.inner');
        return { status: 200 };
      }),
    );
    const second = requestScope(() => tracePhase('second', () => 2));
    release();
    await first.result;
    first.res.emit('finish');
    second.res.emit('close');
    const all = records();
    const firstId = all.find((row) => row.event === 'first.start').traceId;
    const secondId = all.find((row) => row.event === 'second.start').traceId;
    expect(firstId).not.toBe(secondId);
    expect(all.find((row) => row.event === 'first.inner').traceId).toBe(
      firstId,
    );
    expect(all.find((row) => row.event === 'response.finish').traceId).toBe(
      firstId,
    );
    expect(all.find((row) => row.event === 'response.close')).toMatchObject({
      traceId: secondId,
      premature: true,
    });
    expect(all.find((row) => row.event === 'first.end')).toMatchObject({
      status: 200,
      durationMs: expect.any(Number) as unknown,
    });
    expect(first.req.listenerCount('aborted')).toBe(0);
    expect(second.req.listenerCount('aborted')).toBe(0);
    expect(first.setHeader).toHaveBeenCalledWith('X-Ampp-Trace-Id', firstId);
  });

  it('reports request aborts and distinguishes a normal response close', () => {
    process.env.AMPP_PROXY_TRACE = 'true';
    const scope = requestScope(() => {});
    scope.req.emit('aborted');
    Object.assign(scope.res, { writableFinished: true });
    scope.res.emit('finish');
    scope.res.emit('close');
    expect(records().map((row) => row.event)).toEqual([
      'request.received',
      'request.aborted',
      'response.finish',
      'response.close',
    ]);
    expect(records().at(-1).premature).toBe(false);
  });

  it('preserves synchronous/async failures by identity and records safe error classification', async () => {
    process.env.AMPP_PROXY_TRACE = 'true';
    const denied = new ForbiddenException('TOKEN_SECRET');
    const db = Object.assign(new Error('SQL_SECRET'), {
      code: 'ER_LOCK_DEADLOCK',
    });
    requestScope(() => {
      expect(() =>
        tracePhase('policy', () => {
          throw denied;
        }),
      ).toThrow(denied);
    });
    await expect(
      requestScope(() => tracePhase('database', () => Promise.reject(db)))
        .result,
    ).rejects.toBe(db);
    expect(records().find((row) => row.event === 'policy.error')).toMatchObject(
      { status: 403, errorType: 'ForbiddenException' },
    );
    expect(
      records().find((row) => row.event === 'database.error'),
    ).toMatchObject({ errorCode: 'ER_LOCK_DEADLOCK' });
    expect(JSON.stringify(records())).not.toMatch(
      /TOKEN_SECRET|SQL_SECRET|SESSION_SECRET|QUERY_SECRET/,
    );
  });

  it('preserves session-store receiver, callback arguments/receiver, return value and operation count', () => {
    process.env.AMPP_PROXY_TRACE = 'true';
    const failure = Object.assign(new Error('SQL_SECRET'), {
      code: 'ER_LOCK_DEADLOCK',
    });
    const value = { cookie: {}, token: 'BODY_SECRET' };
    const callbackReceiver = {};
    const original = jest.fn(function (
      this: Store,
      _sid: string,
      callback: (...args: unknown[]) => void,
    ) {
      expect(this).toBe(store);
      callback.call(callbackReceiver, failure, value);
      return 17;
    });
    const store = { get: original } as unknown as Store;
    traceSessionStore(store);
    const scope = requestScope(() =>
      store.get('STORE_SESSION_SECRET', function (error, data) {
        expect(this).toBe(callbackReceiver);
        expect(error).toBe(failure);
        expect(data).toBe(value);
      }),
    );
    expect(scope.result).toBe(17);
    expect(original).toHaveBeenCalledTimes(1);
    expect(
      records().find((row) => row.event === 'session.get.error'),
    ).toMatchObject({
      errorCode: 'ER_LOCK_DEADLOCK',
      durationMs: expect.any(Number) as unknown,
    });
    expect(JSON.stringify(records())).not.toMatch(
      /STORE_SESSION_SECRET|BODY_SECRET|SQL_SECRET/,
    );
  });

  it('preserves a store synchronous throw and leaves unrelated store access untraced', () => {
    process.env.AMPP_PROXY_TRACE = 'true';
    const failure = new Error('private error');
    const original = jest.fn(() => {
      throw failure;
    });
    const store = { touch: original } as unknown as Store;
    traceSessionStore(store);
    expect(() => store.touch('sid', {} as never)).toThrow(failure);
    expect(info).not.toHaveBeenCalled();
    requestScope(() =>
      expect(() => store.touch('sid', {} as never)).toThrow(failure),
    );
    expect(original).toHaveBeenCalledTimes(2);
    expect(
      records().find((row) => row.event === 'session.touch.error'),
    ).toBeDefined();
  });

  it('traces the real AMPP HTTP transport without changing headers or response bytes', async () => {
    process.env.AMPP_PROXY_TRACE = 'true';
    const transport = jest.spyOn(axios, 'request').mockResolvedValue({
      status: 200,
      headers: {},
      data: Buffer.from('BODY_SECRET'),
    });
    const service = new AmppCookieHttpService(
      new ConfigService({ PLATFORM_URL: 'https://ampp.invalid' }),
    );
    const scope = requestScope(() =>
      service.request(
        { getCookieString: () => Promise.resolve('') } as unknown as CookieJar,
        '/notifications/api/v1/notifications/ALIAS_SECRET?access_token=QUERY_SECRET',
        {
          headers: { Authorization: 'Bearer HEADER_SECRET' },
        },
      ),
    );
    const response = await scope.result;
    expect(response.status).toBe(200);
    expect(response.body.toString()).toBe('BODY_SECRET');
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][0].headers.Authorization).toBe(
      'Bearer HEADER_SECRET',
    );
    expect(
      records().find((row) => row.event === 'ampp.http.end'),
    ).toMatchObject({ status: 200 });
    expect(JSON.stringify(records())).not.toMatch(
      /BODY_SECRET|HEADER_SECRET|ALIAS_SECRET|QUERY_SECRET/,
    );
  });

  it('does not let a failing log sink or result getter change application outcomes', async () => {
    process.env.AMPP_PROXY_TRACE = 'true';
    const get = jest.fn(() => {
      throw new Error('must not inspect');
    });
    const value = Object.defineProperty({}, 'status', { get });
    info.mockImplementation(() => {
      throw new Error('sink unavailable');
    });
    const scope = requestScope(() =>
      tracePhase('operation', () => Promise.resolve(value)),
    );
    await expect(scope.result).resolves.toBe(value);
    expect(get).not.toHaveBeenCalled();
  });

  it('fingerprints mailbox mappings and excludes secrets in paths, bodies, query and close reasons', () => {
    process.env.AMPP_PROXY_TRACE = 'true';
    const create = '/notifications/api/v1/mailbox';
    const alias = Buffer.from(
      JSON.stringify({ id: 'ALIAS_SECRET', secret: 'MAILBOX_SECRET' }),
    );
    const upstream = Buffer.from(
      JSON.stringify({ id: 'UPSTREAM_SECRET', token: 'BODY_SECRET' }),
    );
    const scope = requestScope((req) => {
      traceMailbox('mailbox.request', 'POST', create, create, alias, upstream);
      traceMailbox(
        'mailbox.response',
        'POST',
        create,
        create,
        alias,
        upstream,
        200,
      );
      traceMailbox(
        'mailbox.request',
        'GET',
        '/notifications/api/v1/notifications/ALIAS_SECRET',
        '/notifications/api/v1/notifications/UPSTREAM_SECRET',
      );
      traceSocketClose(req, 'upstream', 1000, 'reason contains TOKEN_SECRET');
    });
    const mailbox = records().filter((row) => row.event === 'mailbox.request');
    expect(mailbox).toHaveLength(2);
    expect(mailbox[0].aliasId).toBe(mailbox[1].aliasId);
    expect(mailbox[0].upstreamId).toBe(mailbox[1].upstreamId);
    expect(mailbox[0].aliasId).not.toBe(mailbox[0].upstreamId);
    expect(
      records().find((row) => row.event === 'websocket.close'),
    ).toMatchObject({
      reason: 'other',
      reasonBytes: expect.any(Number) as unknown,
    });
    traceForRequest(scope.req, 'external.event');
    expect(records().at(-1).traceId).toBe(records()[0].traceId);
    const safe = tracePath(
      '/notifications/api/v1/mailbox/ALIAS_SECRET/DELETE_SECRET?access_token=QUERY_SECRET',
    );
    expect(safe).toContain(':redacted');
    expect(JSON.stringify(records()) + safe).not.toMatch(
      /ALIAS_SECRET|UPSTREAM_SECRET|MAILBOX_SECRET|TOKEN_SECRET|BODY_SECRET|QUERY_SECRET|DELETE_SECRET|SESSION_SECRET/,
    );
  });

  it('retains WebSocket context and the first observed closing side outside async scope', () => {
    process.env.AMPP_PROXY_TRACE = 'true';
    const req = {
      method: 'GET',
      url: `/api/ampp-proxy/ws/${CONTEXT}/pushnotificationshub?access_token=TOKEN_SECRET`,
      sessionID: 'SESSION_SECRET',
    } as Request;
    traceUpgrade(req, () => traceEvent('websocket.connect.start'));
    traceSocketClose(req, 'proxy', 1008, 'Permission revoked');
    traceSocketClose(req, 'upstream', 1008, Buffer.from('Permission revoked'));
    traceSocketClose(req, 'browser', 1008, Buffer.from('Permission revoked'));
    const closed = records().filter((row) => row.event === 'websocket.close');
    expect(closed.map((row) => row.side)).toEqual([
      'proxy',
      'upstream',
      'browser',
    ]);
    expect(closed.every((row) => row.initiator === 'proxy')).toBe(true);
    expect(new Set(records().map((row) => row.traceId)).size).toBe(1);
    expect(JSON.stringify(records())).not.toMatch(
      /TOKEN_SECRET|SESSION_SECRET/,
    );
  });
});
