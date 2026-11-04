import {
  Controller,
  Get,
  INestApplication,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { Request, Response } from 'express';
import session from 'express-session';
import { createPool } from 'mysql2/promise';
import request from 'supertest';
import type { App } from 'supertest/types';
import { of } from 'rxjs';
import { AuthController } from '../src/auth/auth.controller';
import { AuthService } from '../src/auth/auth.service';
import { MysqlSessionStore } from '../src/auth/mysql-session.store';
import { SessionAuthGuard } from '../src/auth/session-auth.guard';
import { SESSION_MAX_AGE } from '../src/auth/session-cookie';
import { AmppSessionController } from '../src/ampp/controllers/ampp-session.controller';
import { AmppControlController } from '../src/ampp/controllers/ampp-control.controller';
import { AmppControlService } from '../src/ampp/services/ampp-control.service';
import { AmppApiProxyController } from '../src/ampp-proxy/ampp-api-proxy.controller';
import { AmppProxyPolicyService } from '../src/ampp-proxy/ampp-proxy-policy.service';
import { AmppProxyService } from '../src/ampp-proxy/ampp-proxy.service';
import { AmppProxySessionService } from '../src/ampp-proxy/ampp-proxy-session.service';

jest.mock('mysql2/promise', () => ({ createPool: jest.fn() }));

type Row = { expires_at: number; data: string };
type Params = (string | number)[];
type Result = [{ affectedRows: number }] | [Row[]];
type Statement = { sql: string; params: Params; affectedRows?: number };
const user = {
  id: '42',
  username: 'test',
  displayName: 'Test',
  clientId: 1,
  userType: 'user' as const,
};
const workloadId = '10000000-0000-4000-8000-000000000001';
let beforeFixtureReply: (() => void) | undefined;

@Controller('renewal-fixture')
@UseGuards(SessionAuthGuard)
class RenewalFixtureController {
  @Get('read')
  read() {
    beforeFixtureReply?.();
    return { ok: true };
  }

  @Get('data')
  async data(@Req() req: Request) {
    req.session.amppUserId = 'saved-identity';
    req.session.gvuiMailboxes = {
      alias: {
        contextId: 'gvui-layout',
        upstreamId: 'upstream',
        createdAt: 1,
        lastUsedAt: Date.now(),
      },
    };
    req.session.touch();
    await new Promise<void>((resolve, reject) =>
      req.session.save((error?: Error) => (error ? reject(error) : resolve())),
    );
    return { ok: true };
  }

  @Get('early-headers')
  earlyHeaders(@Res() res: Response) {
    res.status(200).setHeader('Content-Type', 'text/event-stream');
    res.flushHeaders();
    res.write('data: first\n\n');
    res.end('data: second\n\n');
  }

  @Get('automatic-data')
  automaticData(@Req() req: Request) {
    req.session.amppUserId = 'automatically-saved-identity';
    return { ok: true };
  }

  @Get('cookies')
  cookies(@Res() res: Response) {
    res.cookie('unrelated', 'retained', {
      expires: new Date(Date.now() + SESSION_MAX_AGE * 2),
      httpOnly: true,
    });
    res.json({ ok: true });
  }

  @Get('disconnect')
  disconnect(@Res() res: Response) {
    beforeFixtureReply?.();
    res.destroy();
  }
}

// Real HTTP middleware, guard, controllers and store; an in-memory SQL adapter
// models conditional row changes. No production MySQL or AMPP is contacted.
// SESSION_RENEWAL_BASELINE=true deliberately runs these fixtures without the
// new middleware on PR10; compatibility must pass and optimization budgets fail.
describe('Session renewal', () => {
  const rows = new Map<string, Row>();
  const statements: Statement[] = [];
  const instances: { app: INestApplication<App>; store: MysqlSessionStore }[] =
    [];
  const refresh = jest.fn<Promise<boolean>, [session.SessionData]>();
  const control = {
    getState: jest.fn(() => Promise.resolve({ sent: true })),
    sendKeyState: jest.fn(() => Promise.resolve({ sent: true })),
    startWebRtcSession: jest.fn(() =>
      Promise.resolve({ tunnelId: 'test-tunnel' }),
    ),
    publishWebRtcSignal: jest.fn(() => Promise.resolve({ sent: true })),
    notificationEvents: () =>
      of(
        {
          data: {
            topic: `gv.ampp.control.${workloadId}.state`,
            content: 'first',
          },
        },
        {
          data: {
            topic: `gv.ampp.control.${workloadId}.state`,
            content: 'second',
          },
        },
      ),
  };
  let app: INestApplication<App>;
  let beforeSql: ((sql: string, params: Params) => void) | undefined;
  let afterSql: ((sql: string, params: Params) => Promise<void>) | undefined;
  let now: number;

  async function createApp(touchIntervalMs = 60000) {
    const options = { port: 3306, touchIntervalMs };
    const store = new MysqlSessionStore(options);
    const config = new ConfigService({ SESSION_COOKIE_NAME: 'renewal.sid' });
    const module = await Test.createTestingModule({
      controllers: [
        AuthController,
        AmppSessionController,
        RenewalFixtureController,
        AmppControlController,
        AmppApiProxyController,
      ],
      providers: [
        SessionAuthGuard,
        { provide: ConfigService, useValue: config },
        { provide: AmppControlService, useValue: control },
        AmppProxySessionService,
        {
          provide: AmppProxyPolicyService,
          useValue: { assertApiAccess: () => '/fixture' },
        },
        {
          provide: AmppProxyService,
          useValue: {
            proxyApiRequest: () => {
              beforeFixtureReply?.();
              return Promise.resolve({
                status: 200,
                headers: { 'content-type': 'application/json' },
                body: Buffer.from('{"ok":true}'),
              });
            },
          },
        },
        {
          provide: AuthService,
          useValue: {
            login: () => Promise.resolve({ user }),
            applyAuthorization: (data: session.SessionData) => {
              data.user = user;
              data.allowedWorkloads = [
                {
                  id: workloadId,
                  name: 'Fixture',
                  is_parent: 0,
                  pageType: 'custom',
                },
              ];
            },
            refreshSessionAuthorization: refresh,
          },
        },
      ],
    }).compile();
    const instance = module.createNestApplication<INestApplication<App>>();
    instance.setGlobalPrefix('api');
    instance.useLogger(false);
    let middleware = session({
      store,
      name: 'renewal.sid',
      secret: 'renewal-test-secret-at-least-32-characters',
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: { maxAge: SESSION_MAX_AGE, httpOnly: true, sameSite: 'lax' },
    });
    if (process.env.SESSION_RENEWAL_BASELINE !== 'true') {
      const renewal = jest.requireActual<
        typeof import('../src/auth/session-renewal')
      >('../src/auth/session-renewal');
      instance.useGlobalInterceptors(
        new renewal.SessionRenewalInterceptor(config, module.get(Reflector)),
      );
      middleware = renewal.withConfirmedSessionCookies(
        middleware,
        store,
        'renewal.sid',
      );
    }
    instance.use(middleware);
    await instance.init();
    instances.push({ app: instance, store });
    return instance;
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    beforeFixtureReply = undefined;
    rows.clear();
    statements.length = 0;
    beforeSql = undefined;
    afterSql = undefined;
    now = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    refresh.mockReset().mockResolvedValue(false);
    const query = (sql: string, params: Params): Result => {
      if (sql.startsWith('CREATE')) return [{ affectedRows: 0 }];
      if (sql.startsWith('SELECT')) {
        const row = rows.get(String(params[0]));
        return [row && row.expires_at > Number(params[1]) ? [{ ...row }] : []];
      }
      if (sql.startsWith('INSERT')) {
        if (rows.has(String(params[0]))) throw new Error('Duplicate session');
        rows.set(String(params[0]), {
          expires_at: Number(params[1]),
          data: String(params[2]),
        });
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('UPDATE')) {
        const full = sql.includes('data = ?');
        const row = rows.get(String(params[full ? 2 : 1]));
        if (
          !row ||
          row.expires_at <= Number(params[full ? 3 : 2]) ||
          (!full &&
            sql.includes('AND expires_at <= ?') &&
            row.expires_at > Number(params[3]))
        ) {
          return [{ affectedRows: 0 }];
        }
        row.expires_at = Math.max(row.expires_at, Number(params[0]));
        if (full) row.data = String(params[1]);
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('DELETE')) {
        let count = 0;
        for (const [sid, row] of rows) {
          const matches = sql.includes('session_id = ?')
            ? sid === params[0] &&
              (!sql.includes('expires_at <= ?') ||
                row.expires_at <= Number(params[1]))
            : row.expires_at <= Number(params[0]);
          if (matches && count < 1000) {
            rows.delete(sid);
            count++;
          }
        }
        return [{ affectedRows: count }];
      }
      throw new Error('Unexpected SQL');
    };
    const execute = jest.fn(async (sql: string, params: Params = []) => {
      beforeSql?.(sql, params);
      const result = query(sql, params);
      statements.push({
        sql,
        params,
        ...('affectedRows' in result[0]
          ? { affectedRows: result[0].affectedRows }
          : {}),
      });
      await afterSql?.(sql, params);
      return result;
    });
    jest
      .mocked(createPool)
      .mockReturnValue({ execute, end: jest.fn() } as never);
    app = await createApp();
  });

  afterEach(async () => {
    for (const instance of instances.splice(0)) {
      await instance.app.close();
      await instance.store.close();
    }
    jest.restoreAllMocks();
  });

  async function login(instance = app) {
    const response = await request(instance.getHttpServer())
      .post('/api/auth/login')
      .send({ username: 'test', password: 'mocked' })
      .expect(201);
    statements.length = 0;
    return response.headers['set-cookie'][0].split(';')[0];
  }
  const updated = () => statements.filter((s) => s.sql.startsWith('UPDATE'));
  const row = () => [...rows.values()][0];
  const stored = () => JSON.parse(row().data) as session.SessionData;
  const cookieDeadline = (response: request.Response) => {
    const cookies = response.headers['set-cookie'] as unknown as string[];
    const cookie = cookies.find((value) => value.startsWith('renewal.sid='));
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    return new Date(cookie.match(/Expires=([^;]+)/)[1]).getTime();
  };

  describe('compatibility', () => {
    it('keeps deadlines backed by the row across successive polls', async () => {
      const cookie = await login();
      for (const step of [20000, 39999, 1, 20000]) {
        now += step;
        const response = await request(app.getHttpServer())
          .get('/api/ampp/session/current')
          .set('Cookie', cookie)
          .expect(200);
        const body = response.body as { expiresAt: number; serverTime: number };
        expect(body.expiresAt).toBeLessThanOrEqual(row().expires_at);
        expect(body.expiresAt).toBeGreaterThan(now + SESSION_MAX_AGE - 60000);
        expect(cookieDeadline(response)).toBeLessThanOrEqual(row().expires_at);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(stored().user).toEqual(user);
      }
    });

    it.each([false, true])(
      'rejects revocation during authorization (refresh %s)',
      async (changed) => {
        const cookie = await login();
        refresh.mockImplementationOnce(() => {
          rows.clear();
          return Promise.resolve(changed);
        });
        const response = await request(app.getHttpServer())
          .get('/api/ampp/session/current')
          .set('Cookie', cookie)
          .expect(401);
        expect((response.body as { code: string }).code).toBe(
          'SESSION_EXPIRED',
        );
        expect(rows.size).toBe(0);
        expect(response.headers['set-cookie'][0]).toContain('1970');
      },
    );

    it('retains later expiry written by another process', async () => {
      const cookie = await login();
      const later = now + SESSION_MAX_AGE + 60000;
      refresh.mockImplementationOnce(() => {
        row().expires_at = later;
        return Promise.resolve(false);
      });
      const response = await request(app.getHttpServer())
        .get('/api/ampp/session/current')
        .set('Cookie', cookie)
        .expect(200);
      expect(row().expires_at).toBe(later);
      expect(
        (response.body as { expiresAt: number }).expiresAt,
      ).toBeLessThanOrEqual(later);
    });

    it('saves authorization and mailbox/identity changes immediately', async () => {
      const cookie = await login();
      now += 20000;
      refresh.mockImplementationOnce((data) => {
        data.authorizationCheckedAt = now;
        data.allowedGvuiLayoutIds = ['new'];
        return Promise.resolve(true);
      });
      await request(app.getHttpServer())
        .get('/api/ampp/session/current')
        .set('Cookie', cookie)
        .expect(200);
      expect(stored().authorizationCheckedAt).toBe(now);
      expect(stored().allowedGvuiLayoutIds).toEqual(['new']);
      await request(app.getHttpServer())
        .get('/api/renewal-fixture/data')
        .set('Cookie', cookie)
        .expect(200);
      expect(stored().amppUserId).toBe('saved-identity');
      expect(stored().gvuiMailboxes?.alias.lastUsedAt).toBe(now);
      expect(row().expires_at).toBe(now + SESSION_MAX_AGE);
    });

    it('recovers from a temporary database read failure without destroying the session', async () => {
      const cookie = await login();
      let fail = true;
      beforeSql = (sql) => {
        if (sql.startsWith('SELECT') && fail) {
          fail = false;
          throw new Error('Mocked read failure');
        }
      };
      await request(app.getHttpServer())
        .get('/api/ampp/session/current')
        .set('Cookie', cookie)
        .expect(500);
      expect(rows.size).toBe(1);
      await request(app.getHttpServer())
        .get('/api/ampp/session/current')
        .set('Cookie', cookie)
        .expect(200);
    });

    it('keeps logout and fresh login working after renewal', async () => {
      const cookie = await login();
      now += 60000;
      await request(app.getHttpServer())
        .get('/api/ampp/session/current')
        .set('Cookie', cookie)
        .expect(200);
      await request(app.getHttpServer())
        .post('/api/auth/logout')
        .set('Cookie', cookie)
        .expect(204);
      expect(rows.size).toBe(0);
      await request(app.getHttpServer())
        .get('/api/ampp/session/current')
        .set('Cookie', cookie)
        .expect(401);
      expect(await login()).not.toBe(cookie);
    });

    it('preserves ordinary early-header response contents and cookie flags', async () => {
      const cookie = await login();
      const response = await request(app.getHttpServer())
        .get('/api/renewal-fixture/early-headers')
        .set('Cookie', cookie)
        .expect(200);
      expect(response.text).toBe('data: first\n\ndata: second\n\n');
      expect(cookieDeadline(response)).toBeLessThanOrEqual(row().expires_at);
    });

    it('preserves automatic data saves after the pre-response renewal', async () => {
      const cookie = await login();
      now += 20000;
      const response = await request(app.getHttpServer())
        .get('/api/renewal-fixture/automatic-data')
        .set('Cookie', cookie)
        .expect(200);
      expect(stored().amppUserId).toBe('automatically-saved-identity');
      expect(updated().some((s) => s.sql.includes('data = ?'))).toBe(true);
      expect(cookieDeadline(response)).toBeLessThanOrEqual(row().expires_at);
    });

    it('restores renewal on every poll when the configured interval is zero', async () => {
      const legacy = await createApp(0);
      const cookie = await login(legacy);
      for (const step of [10000, 10000]) {
        now += step;
        const response = await request(legacy.getHttpServer())
          .get('/api/ampp/session/current')
          .set('Cookie', cookie)
          .expect(200);
        expect((response.body as { expiresAt: number }).expiresAt).toBe(
          now + SESSION_MAX_AGE,
        );
      }
      expect(updated()).toHaveLength(2);
    });

    it('keeps direct store reads used by socket and merge rechecks read-only', async () => {
      await login();
      const deadline = row().expires_at;
      const sid = [...rows.keys()][0];
      now += 120000;
      const result = await new Promise<session.SessionData | null>(
        (resolve, reject) => {
          void instances[0].store.get(sid, (error: Error | null, data) =>
            error ? reject(error) : resolve(data ?? null),
          );
        },
      );
      expect(result?.user).toEqual(user);
      expect(updated()).toHaveLength(0);
      expect(row().expires_at).toBe(deadline);
    });

    it('retains the signed session value and unrelated response cookies', async () => {
      const cookie = await login();
      now += 20000;
      const otherDeadline =
        Math.floor((now + SESSION_MAX_AGE * 2) / 1000) * 1000;
      const response = await request(app.getHttpServer())
        .get('/api/renewal-fixture/cookies')
        .set('Cookie', cookie)
        .expect(200);
      const cookies = response.headers['set-cookie'] as unknown as string[];
      expect(
        cookies.find((value) => value.startsWith('renewal.sid=')).split(';')[0],
      ).toBe(cookie);
      const other = cookies.find((value) => value.startsWith('unrelated='));
      expect(other).toContain('unrelated=retained;');
      expect(new Date(other.match(/Expires=([^;]+)/)[1]).getTime()).toBe(
        otherDeadline,
      );
      expect(other).toContain('HttpOnly');
    });

    it('preserves Mini Mixer command HTTP contracts', async () => {
      const cookie = await login();
      now += 20000;
      const body = {
        workloadId,
        applicationName: 'MiniMixer',
        transitionType: 'Cut',
        active: true,
      };
      await request(app.getHttpServer())
        .post('/api/ampp/control/get-state')
        .set('Cookie', cookie)
        .send({ workloadId })
        .expect(201, { sent: true });
      await request(app.getHttpServer())
        .post('/api/ampp/control/key-state')
        .set('Cookie', cookie)
        .send(body)
        .expect(201, { sent: true });
      expect(control.getState).toHaveBeenCalledWith({ workloadId });
      expect(control.sendKeyState).toHaveBeenCalledTimes(1);
      expect(control.sendKeyState).toHaveBeenCalledWith(body);
    });

    it('preserves Flow Monitor WebRTC session and signaling HTTP contracts', async () => {
      const cookie = await login();
      now += 20000;
      const body = { workloadId, engineInstanceId: 'fixture-engine' };
      await request(app.getHttpServer())
        .post('/api/ampp/control/webrtc/session')
        .set('Cookie', cookie)
        .send(body)
        .expect(201, { tunnelId: 'test-tunnel' });
      const signal = {
        ...body,
        topic: 'fixture-topic',
        content: { type: 'answer' },
      };
      await request(app.getHttpServer())
        .post('/api/ampp/control/webrtc/signal')
        .set('Cookie', cookie)
        .send(signal)
        .expect(201, { sent: true });
      expect(control.startWebRtcSession).toHaveBeenCalledWith(body);
      expect(control.publishWebRtcSignal).toHaveBeenCalledWith(signal);
    });

    it('preserves real SSE delivery without SQL operations for each message', async () => {
      const cookie = await login();
      now += 20000;
      const response = await request(app.getHttpServer())
        .get('/api/ampp/control/notifications/stream')
        .set('Cookie', cookie)
        .expect(200);
      expect(response.text).toContain('first');
      expect(response.text).toContain('second');
      expect(cookieDeadline(response)).toBeLessThanOrEqual(row().expires_at);
      expect(
        statements.filter((s) => /^(SELECT|UPDATE)/.test(s.sql)).length,
      ).toBeLessThanOrEqual(2);
    });
  });

  describe('slow response compatibility', () => {
    it('does not perform a post-handler renewal after disconnect', async () => {
      const cookie = await login();
      beforeFixtureReply = () => {
        now += 120000;
      };
      await expect(
        request(app.getHttpServer())
          .get('/api/renewal-fixture/disconnect')
          .set('Cookie', cookie),
      ).rejects.toThrow();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(updated()).toHaveLength(0);
    });
    it.each([
      '/api/renewal-fixture/read',
      `/api/ampp-proxy/api/${workloadId}/fixture`,
    ])(
      'keeps the final deadline current for a slow handler at %s',
      async (path) => {
        const cookie = await login();
        now += 20000;
        beforeFixtureReply = () => {
          now += 120000;
        };
        const response = await request(app.getHttpServer())
          .get(path)
          .set('Cookie', cookie)
          .expect(200);
        expect(row().expires_at).toBe(now + SESSION_MAX_AGE);
        expect(cookieDeadline(response)).toBe(
          Math.floor(row().expires_at / 1000) * 1000,
        );
      },
    );
  });

  describe('session lifecycle compatibility', () => {
    it.each(['login', 'logout'])(
      'allows %s after the old row is revoked during load',
      async (action) => {
        const cookie = await login();
        let revoke = true;
        afterSql = (sql) => {
          if (sql.startsWith('SELECT data') && revoke) {
            revoke = false;
            rows.clear();
          }
          return Promise.resolve();
        };
        const response = await request(app.getHttpServer())
          .post(`/api/auth/${action}`)
          .set('Cookie', cookie)
          .send({ username: 'test', password: 'mocked' })
          .expect(action === 'login' ? 201 : 204);
        expect(rows.size).toBe(action === 'login' ? 1 : 0);
        if (action === 'logout')
          expect(response.headers['set-cookie'][0]).toContain('1970');
      },
    );
  });

  describe('required protection', () => {
    it('rejects expiry while authorizing an ordinary endpoint', async () => {
      const cookie = await login();
      refresh.mockImplementationOnce(() => {
        now = row().expires_at + 1;
        return Promise.resolve(false);
      });
      await request(app.getHttpServer())
        .get('/api/renewal-fixture/read')
        .set('Cookie', cookie)
        .expect(401);
      expect(rows.size).toBe(0);
    });
  });

  describe('renewal budget', () => {
    it('performs no UPDATEs within the interval on polls and ordinary HTTP requests', async () => {
      const cookie = await login();
      const initial = row().data;
      for (const path of [
        '/api/ampp/session/current',
        '/api/renewal-fixture/read',
        '/api/renewal-fixture/early-headers',
      ]) {
        now += 10000;
        const response = await request(app.getHttpServer())
          .get(path)
          .set('Cookie', cookie)
          .expect(200);
        expect(cookieDeadline(response)).toBeLessThanOrEqual(row().expires_at);
      }
      expect(updated()).toHaveLength(0);
      expect(row().data).toBe(initial);
    });

    it('does not renew at 59999 ms and renews exactly at 60000 ms', async () => {
      const cookie = await login();
      const initial = row().expires_at;
      now += 59999;
      await request(app.getHttpServer())
        .get('/api/ampp/session/current')
        .set('Cookie', cookie)
        .expect(200);
      expect(updated()).toHaveLength(0);
      expect(row().expires_at).toBe(initial);
      now++;
      const response = await request(app.getHttpServer())
        .get('/api/ampp/session/current')
        .set('Cookie', cookie)
        .expect(200);
      expect(updated()).toHaveLength(1);
      expect(row().expires_at).toBe(now + SESSION_MAX_AGE);
      expect((response.body as { expiresAt: number }).expiresAt).toBe(
        row().expires_at,
      );
    });

    it('keeps early-header cookies on the stored deadline when renewal is skipped', async () => {
      const cookie = await login();
      const deadline = row().expires_at;
      now += 20000;
      const response = await request(app.getHttpServer())
        .get('/api/renewal-fixture/early-headers')
        .set('Cookie', cookie)
        .expect(200);
      expect(updated()).toHaveLength(0);
      expect(cookieDeadline(response)).toBe(Math.floor(deadline / 1000) * 1000);
      expect(row().expires_at).toBe(deadline);
    });

    it('allows only one matching renewal when two API instances race', async () => {
      const second = await createApp();
      const cookie = await login();
      now += 60000;
      let reads = 0;
      let release: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      afterSql = async (sql) => {
        if (/SELECT expires_at/.test(sql) && reads < 2) {
          reads++;
          if (reads === 2) release();
          await gate;
        }
      };
      await Promise.all(
        [app, second].map((instance) =>
          request(instance.getHttpServer())
            .get('/api/ampp/session/current')
            .set('Cookie', cookie)
            .expect(200),
        ),
      );
      expect(updated().filter((s) => s.affectedRows)).toHaveLength(1);
      expect(row().expires_at).toBe(now + SESSION_MAX_AGE);
    });

    it('rechecks zero-row conditional updates rather than treating a deleted row as fresh', async () => {
      const cookie = await login();
      now += 60000;
      beforeSql = (sql) => {
        if (sql.startsWith('UPDATE') && !sql.includes('data = ?')) rows.clear();
      };
      await request(app.getHttpServer())
        .get('/api/ampp/session/current')
        .set('Cookie', cookie)
        .expect(401);
      expect(rows.size).toBe(0);
      expect(statements.some((s) => s.sql.startsWith('INSERT'))).toBe(false);
    });

    it('fails a fresh-session validation read and recovers on retry', async () => {
      const cookie = await login();
      let fail = true;
      beforeSql = (sql) => {
        if (/SELECT expires_at/.test(sql) && fail) {
          fail = false;
          throw new Error('Mocked freshness read failure');
        }
      };
      await request(app.getHttpServer())
        .get('/api/ampp/session/current')
        .set('Cookie', cookie)
        .expect(500);
      expect(rows.size).toBe(1);
      await request(app.getHttpServer())
        .get('/api/ampp/session/current')
        .set('Cookie', cookie)
        .expect(200);
      expect(updated()).toHaveLength(0);
    });
  });
});
