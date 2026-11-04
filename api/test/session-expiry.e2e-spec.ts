import {
  Controller,
  Get,
  INestApplication,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { tap } from 'rxjs';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import session from 'express-session';
import { createPool } from 'mysql2/promise';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AuthController } from '../src/auth/auth.controller';
import { AuthService } from '../src/auth/auth.service';
import { MysqlSessionStore } from '../src/auth/mysql-session.store';
import { SessionAuthGuard } from '../src/auth/session-auth.guard';
import {
  SESSION_MAX_AGE,
  sessionCookieSettings,
} from '../src/auth/session-cookie';
import { AmppSessionController } from '../src/ampp/controllers/ampp-session.controller';

jest.mock('mysql2/promise', () => ({ createPool: jest.fn() }));

type SessionRow = { expires_at: number; data: string };
type SqlResult = [{ affectedRows: number }] | [SessionRow[]];

@Controller('session-compatibility')
@UseGuards(SessionAuthGuard)
class SessionCompatibilityController {
  @Get('read')
  read() {
    return { ok: true };
  }

  @Get('mutate')
  mutate(@Req() req: Request) {
    req.session.amppUserId = 'changed-by-another-endpoint';
    return { ok: true };
  }
}

// Run the real store, cookie middleware, controllers and guard using a small
// in-memory SQL adapter. SQL predicates are checked in the store unit tests;
// local MySQL validation is still required. Neither MySQL nor AMPP is contacted.
describe('Browser session lifecycle (isolated HTTP)', () => {
  let app: INestApplication<App>;
  let store: MysqlSessionStore;
  const rows = new Map<string, SessionRow>();
  const user = {
    id: 'test-user',
    username: 'test',
    displayName: 'Test',
    clientId: 1,
    userType: 'user',
  };
  const refresh = jest.fn();
  const config = new ConfigService({ SESSION_COOKIE_NAME: 'test.sid' });
  let execute: jest.Mock<
    Promise<SqlResult>,
    [sql: string, params?: (string | number)[]]
  >;
  let afterHandler: ((req: Request) => void) | undefined;

  beforeEach(async () => {
    rows.clear();
    afterHandler = undefined;
    refresh.mockReset().mockResolvedValue(false);
    const query = (
      sql: string,
      params: (string | number)[] = [],
    ): SqlResult => {
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
      if (sql.startsWith('UPDATE')) {
        const hasData = sql.includes('data = ?');
        const row = rows.get(String(params[hasData ? 2 : 1]));
        if (!row || row.expires_at <= Number(params[hasData ? 3 : 2]))
          return [{ affectedRows: 0 }];
        row.expires_at = Math.max(row.expires_at, Number(params[0]));
        if (hasData) row.data = String(params[1]);
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    };
    execute = jest.fn((...args: Parameters<typeof query>) =>
      Promise.resolve(query(...args)),
    );
    jest
      .mocked(createPool)
      .mockReturnValue({ execute, end: jest.fn() } as never);
    const storeOptions = { port: 3306, touchIntervalMs: 0 };
    store = new MysqlSessionStore(storeOptions);
    const module = await Test.createTestingModule({
      controllers: [
        AuthController,
        AmppSessionController,
        SessionCompatibilityController,
      ],
      providers: [
        SessionAuthGuard,
        { provide: ConfigService, useValue: config },
        {
          provide: AuthService,
          useValue: {
            login: jest.fn().mockResolvedValue({ user }),
            applyAuthorization: (data: session.SessionData) => {
              data.user = user as never;
            },
            refreshSessionAuthorization: refresh,
          },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalInterceptors({
      intercept: (context, next) =>
        next
          .handle()
          .pipe(
            tap(() =>
              afterHandler?.(context.switchToHttp().getRequest<Request>()),
            ),
          ),
    });
    const cookie = sessionCookieSettings(config);
    app.use(
      session({
        store,
        name: cookie.name,
        secret: 'isolated-session-test-secret-at-least-32-characters',
        resave: false,
        saveUninitialized: false,
        rolling: true,
        cookie: { ...cookie.cookie, maxAge: SESSION_MAX_AGE },
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    await store.close();
    jest.restoreAllMocks();
  });

  async function login() {
    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ username: 'test', password: 'mocked' })
      .expect(201);
    return response.headers['set-cookie'][0].split(';')[0];
  }

  const updates = () =>
    execute.mock.calls.filter(([sql]: [string]) => sql.startsWith('UPDATE'));
  const storedData = () =>
    JSON.parse([...rows.values()][0].data) as session.SessionData;

  it('persists refreshed access and the recheck timestamp before returning them', async () => {
    const cookie = await login();
    const checkedAt = Date.now();
    const layouts = [
      { id: 'new-layout', name: 'New', associatedWorkloadId: null },
    ];
    refresh.mockImplementationOnce((data: session.SessionData) => {
      data.authorizationCheckedAt = checkedAt;
      data.allowedGvuiLayouts = layouts;
      data.allowedGvuiLayoutIds = ['new-layout'];
      data.gvuiMailboxes = undefined;
      return Promise.resolve(true);
    });
    const response = await request(app.getHttpServer())
      .get('/api/ampp/session/current')
      .set('Cookie', cookie)
      .expect(200);
    const stored = storedData();
    expect(stored.authorizationCheckedAt).toBe(checkedAt);
    expect(stored.allowedGvuiLayouts).toEqual(layouts);
    expect((response.body as session.SessionData).allowedGvuiLayouts).toEqual(
      layouts,
    );
    expect(stored.gvuiMailboxes).toBeUndefined();
  });

  it('never publishes a deadline beyond the row or cookie when finalization is delayed', async () => {
    const cookie = await login();
    const now = Date.now() + 60000;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    afterHandler = (req) => {
      if (req.path === '/api/ampp/session/current')
        clock.mockReturnValue(now + 5000);
    };
    const response = await request(app.getHttpServer())
      .get('/api/ampp/session/current')
      .set('Cookie', cookie)
      .expect(200);
    const deadline = (response.body as { expiresAt: number }).expiresAt;
    const cookieExpiry =
      response.headers['set-cookie'][0].match(/Expires=([^;]+)/)[1];
    expect(deadline).toBe(now + SESSION_MAX_AGE);
    expect(deadline).toBeLessThanOrEqual([...rows.values()][0].expires_at);
    expect(new Date(cookieExpiry).getTime()).toBeLessThanOrEqual(
      [...rows.values()][0].expires_at,
    );
  });

  it('does not shorten a concurrent renewal by another tab', async () => {
    const cookie = await login();
    const concurrentDeadline = Date.now() + SESSION_MAX_AGE + 60000;
    refresh.mockImplementationOnce(() => {
      [...rows.values()][0].expires_at = concurrentDeadline;
      return Promise.resolve(false);
    });
    const response = await request(app.getHttpServer())
      .get('/api/ampp/session/current')
      .set('Cookie', cookie)
      .expect(200);
    expect([...rows.values()][0].expires_at).toBe(concurrentDeadline);
    expect(
      (response.body as { expiresAt: number }).expiresAt,
    ).toBeLessThanOrEqual(concurrentDeadline);
  });

  it('still saves data changed after the current-session controller completes', async () => {
    const cookie = await login();
    afterHandler = (req) => {
      if (req.path === '/api/ampp/session/current')
        req.session.amppUserId = 'late-change';
    };
    await request(app.getHttpServer())
      .get('/api/ampp/session/current')
      .set('Cookie', cookie)
      .expect(200);
    expect(storedData().amppUserId).toBe('late-change');
  });

  it('does not defer authorization persistence on other endpoints', async () => {
    const cookie = await login();
    refresh.mockImplementationOnce((data: session.SessionData) => {
      data.authorizationCheckedAt = 123;
      return Promise.resolve(true);
    });
    afterHandler = (req) => {
      if (req.path === '/api/session-compatibility/read') {
        expect(storedData().authorizationCheckedAt).toBe(123);
      }
    };
    await request(app.getHttpServer())
      .get('/api/session-compatibility/read')
      .set('Cookie', cookie)
      .expect(200);
  });

  it('still persists ordinary endpoint mutations after a current-session poll', async () => {
    const cookie = await login();
    await request(app.getHttpServer())
      .get('/api/ampp/session/current')
      .set('Cookie', cookie)
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/session-compatibility/mutate')
      .set('Cookie', cookie)
      .expect(200);
    expect(storedData().amppUserId).toBe('changed-by-another-endpoint');
  });

  it('rejects expiry during authorization instead of renewing the expired row', async () => {
    const cookie = await login();
    const deadline = [...rows.values()][0].expires_at;
    refresh.mockImplementationOnce(() => {
      jest.spyOn(Date, 'now').mockReturnValue(deadline + 1);
      return Promise.resolve(false);
    });
    await request(app.getHttpServer())
      .get('/api/ampp/session/current')
      .set('Cookie', cookie)
      .expect(401);
    expect(rows.size).toBe(0);
  });

  it('fails a poll on a database write error and can recover on the next poll', async () => {
    const cookie = await login();
    const normalExecute = execute.getMockImplementation();
    let fail = true;
    execute.mockImplementation((sql, params) => {
      if (sql.startsWith('UPDATE') && fail) {
        fail = false;
        return Promise.reject(new Error('Mocked write failure'));
      }
      return normalExecute(sql, params);
    });
    app.useLogger(false);
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

  it('renews successive polls while preserving proxy ownership and identity', async () => {
    const cookie = await login();
    const row = [...rows.values()][0];
    const data = storedData();
    data.amppUserId = 'retained-upstream-user';
    data.gvuiMailboxes = {
      alias: {
        contextId: 'gvui-layout',
        upstreamId: 'upstream',
        createdAt: 123,
        lastUsedAt: 456,
      },
    };
    row.data = JSON.stringify(data);
    const initialTime = Date.now();
    const clock = jest.spyOn(Date, 'now');
    for (const offset of [60000, 120000, 180000]) {
      clock.mockReturnValue(initialTime + offset);
      const response = await request(app.getHttpServer())
        .get('/api/ampp/session/current')
        .set('Cookie', cookie)
        .expect(200);
      expect((response.body as { expiresAt: number }).expiresAt).toBe(
        initialTime + offset + SESSION_MAX_AGE,
      );
      expect(row.expires_at).toBe(initialTime + offset + SESSION_MAX_AGE);
      expect(storedData().amppUserId).toBe(data.amppUserId);
      expect(storedData().gvuiMailboxes).toEqual(data.gvuiMailboxes);
    }
  });

  // These budget assertions intentionally fail on unchanged main; run them
  // separately from compatibility tests to record the measured improvement.
  describe('current-session write budget', () => {
    it.each([false, true])(
      'uses one UPDATE when authorization refresh is %s',
      async (changed) => {
        const cookie = await login();
        const now = Date.now() + 60000;
        const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
        afterHandler = () => clock.mockReturnValue(now + 5000);
        refresh.mockImplementationOnce((data: session.SessionData) => {
          if (changed) data.authorizationCheckedAt = 123;
          return Promise.resolve(changed);
        });
        execute.mockClear();
        const response = await request(app.getHttpServer())
          .get('/api/ampp/session/current')
          .set('Cookie', cookie)
          .expect(200);
        expect(updates()).toHaveLength(1);
        expect(updates()[0][0].includes('data = ?')).toBe(changed);
        const deadline = (response.body as { expiresAt: number }).expiresAt;
        const cookieExpiry =
          response.headers['set-cookie'][0].match(/Expires=([^;]+)/)[1];
        expect([...rows.values()][0].expires_at).toBe(deadline);
        expect(new Date(cookieExpiry).getTime()).toBe(
          Math.floor(deadline / 1000) * 1000,
        );
      },
    );
  });

  it('renews an authenticated poll for eight hours with no user interaction', async () => {
    const cookie = await login();
    const sid = [...rows.keys()][0];
    const original = rows.get(sid).expires_at;
    const now = Date.now() + 60000;
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const response = await request(app.getHttpServer())
      .get('/api/ampp/session/current')
      .set('Cookie', cookie)
      .expect(200);
    expect(rows.size).toBe(1);
    expect((response.body as { expiresAt: number }).expiresAt).toBe(
      now + SESSION_MAX_AGE,
    );
    expect(rows.get(sid).expires_at).toBeGreaterThan(original);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['set-cookie'][0]).toContain('test.sid=');
    expect(response.body.allowedGvuiLayoutIds).toEqual([]);
    expect(response.body.allowedGvuiLayouts).toEqual([]);
  });

  it('includes effective GVUI access in session responses', async () => {
    const cookie = await login();
    const row = [...rows.values()][0];
    const data = JSON.parse(row.data);
    data.allowedGvuiLayoutIds = ['layout-uuid'];
    data.allowedGvuiLayouts = [{ id: 'layout-uuid', name: 'Layout', associatedWorkloadId: null }];
    row.data = JSON.stringify(data);
    const response = await request(app.getHttpServer()).get('/api/ampp/session/current')
      .set('Cookie', cookie).expect(200);
    expect(response.body.allowedGvuiLayoutIds).toEqual(data.allowedGvuiLayoutIds);
    expect(response.body.allowedGvuiLayouts).toEqual(data.allowedGvuiLayouts);
  });

  it('rejects an expired cookie, deletes its row and clears the configured cookie', async () => {
    const cookie = await login();
    [...rows.values()][0].expires_at = Date.now() - 1;
    const response = await request(app.getHttpServer())
      .get('/api/ampp/session/current')
      .set('Cookie', cookie)
      .expect(401);
    expect((response.body as { code: string }).code).toBe('SESSION_EXPIRED');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['set-cookie'][0]).toMatch(
      /test.sid=; Path=\/; Expires=.*1970.*HttpOnly; SameSite=Lax/,
    );
    expect(rows.size).toBe(0);
  });

  it('rejects a missing/revoked row without recreating it', async () => {
    const cookie = await login();
    rows.clear();
    await request(app.getHttpServer())
      .get('/api/ampp/session/current')
      .set('Cookie', cookie)
      .expect(401);
    expect(rows.size).toBe(0);
  });

  it.each([false, true])(
    'rejects revocation between load and save (permissions changed: %s)',
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
      expect((response.body as { code: string }).code).toBe('SESSION_EXPIRED');
      expect(response.headers['set-cookie'][0]).toContain('test.sid=;');
      expect(rows.size).toBe(0);
    },
  );

  it('destroys the session when the account no longer exists', async () => {
    const cookie = await login();
    refresh.mockRejectedValueOnce(
      new UnauthorizedException('Account no longer exists'),
    );
    await request(app.getHttpServer())
      .get('/api/ampp/session/current')
      .set('Cookie', cookie)
      .expect(401);
    expect(rows.size).toBe(0);
  });

  it('does not revoke a valid session for a temporary authorization lookup failure', async () => {
    const cookie = await login();
    refresh.mockRejectedValueOnce(new Error('Mocked temporary lookup failure'));
    app.useLogger(false);
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

  it('destroys on logout and issues a fresh session on subsequent login', async () => {
    const oldCookie = await login();
    await request(app.getHttpServer())
      .post('/api/auth/logout')
      .set('Cookie', oldCookie)
      .expect(204);
    expect(rows.size).toBe(0);
    const newCookie = await login();
    expect(newCookie).not.toBe(oldCookie);
    await request(app.getHttpServer())
      .get('/api/ampp/session/current')
      .set('Cookie', oldCookie)
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/ampp/session/current')
      .set('Cookie', newCookie)
      .expect(200);
  });

  it('allows login after expiry without reusing the expired session ID', async () => {
    const oldCookie = await login();
    [...rows.values()][0].expires_at = Date.now() - 1;
    await request(app.getHttpServer())
      .get('/api/ampp/session/current')
      .set('Cookie', oldCookie)
      .expect(401);
    const newCookie = await login();
    expect(newCookie).not.toBe(oldCookie);
    await request(app.getHttpServer())
      .get('/api/ampp/session/current')
      .set('Cookie', newCookie)
      .expect(200);
  });
});
