import { INestApplication, UnauthorizedException } from '@nestjs/common';
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

// Run the real store, cookie middleware, controllers and guard using a small
// in-memory SQL adapter. SQL predicates are checked in the store unit tests;
// local MySQL validation is still required. Neither MySQL nor AMPP is contacted.
describe('Browser session lifecycle (isolated HTTP)', () => {
  let app: INestApplication<App>;
  let store: MysqlSessionStore;
  const rows = new Map<string, { expires_at: number; data: string }>();
  const user = {
    id: 'test-user',
    username: 'test',
    displayName: 'Test',
    clientId: 1,
    userType: 'user',
  };
  const refresh = jest.fn();
  const config = new ConfigService({ SESSION_COOKIE_NAME: 'test.sid' });

  beforeEach(async () => {
    rows.clear();
    refresh.mockReset().mockResolvedValue(false);
    const query = (sql: string, params: (string | number)[] = []) => {
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
    const execute = jest.fn((...args: Parameters<typeof query>) =>
      Promise.resolve(query(...args)),
    );
    jest
      .mocked(createPool)
      .mockReturnValue({ execute, end: jest.fn() } as never);
    store = new MysqlSessionStore({ port: 3306 });
    const module = await Test.createTestingModule({
      controllers: [AuthController, AmppSessionController],
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
