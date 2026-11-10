import session from 'express-session';
import { createPool } from 'mysql2/promise';
import { MysqlSessionStore, SessionExpiredError } from '../mysql-session.store';
import { SESSION_MAX_AGE } from '../session-cookie';

jest.mock('mysql2/promise', () => ({ createPool: jest.fn() }));

describe('MysqlSessionStore expiry and revocation', () => {
  let store: MysqlSessionStore;
  let execute: jest.Mock<Promise<[unknown]>, [string, unknown[]?]>;
  const data = () => ({
    cookie: new session.Cookie({ maxAge: SESSION_MAX_AGE }),
  });
  const get = (sid: string) =>
    new Promise<session.SessionData | null>((resolve, reject) => {
      void store.get(sid, (error: Error | null, value) =>
        error ? reject(error) : resolve(value ?? null),
      );
    });
  const write = (method: 'set' | 'touch', sid = 'sid') =>
    new Promise<void>((resolve, reject) => {
      void store[method](sid, data(), (error?: Error) =>
        error ? reject(error) : resolve(),
      );
    });

  beforeEach(async () => {
    execute = jest
      .fn<Promise<[unknown]>, [string, unknown[]?]>()
      .mockResolvedValue([{ affectedRows: 1 }]);
    jest
      .mocked(createPool)
      .mockReturnValue({ execute, end: jest.fn() } as never);
    const options = { port: 3306, touchIntervalMs: 0 };
    store = new MysqlSessionStore(options);
    // Await initialization through the same public path used by login.
    await store.create('initial', data());
    execute.mockClear();
  });

  afterEach(async () => {
    await store.close();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('ends an encountered expired row without ending a concurrent renewal', async () => {
    execute.mockResolvedValueOnce([[]]);
    expect(await get('expired')).toBeNull();
    expect(execute).toHaveBeenLastCalledWith(
      expect.stringMatching(
        /UPDATE.*session_id = \? AND ended_at IS NULL AND expires_at <= \?/s,
      ),
      [
        expect.any(Number),
        expect.any(Number),
        'expired',
        expect.any(Number),
        'expired',
        expect.any(Number),
      ],
    );
  });

  it('loads the current indexed deadline rather than stale JSON cookie expiry', async () => {
    const expiresAt = Date.now() + SESSION_MAX_AGE;
    execute.mockResolvedValueOnce([
      [{ data: JSON.stringify(data()), expires_at: expiresAt }],
    ]);
    const loaded = await get('sid');
    expect(loaded?.cookie.expires?.getTime()).toBe(expiresAt);
  });

  it.each(['set', 'touch'] as const)(
    '%s rejects a missing, expired, or concurrently deleted row',
    async (method) => {
      execute.mockResolvedValueOnce([{ affectedRows: 0 }]);
      await expect(write(method)).rejects.toBeInstanceOf(SessionExpiredError);
      expect(execute).toHaveBeenCalledWith(
        expect.stringMatching(
          /UPDATE user_sessions.*GREATEST\(expires_at, \?\).*WHERE session_id = \? AND expires_at > \?/s,
        ),
        expect.any(Array),
      );
      expect(execute.mock.calls[0][0]).not.toMatch(
        /INSERT|UPSERT|ON DUPLICATE/,
      );
    },
  );

  it('creates a row only through the explicit login creation path', async () => {
    await store.create('new-login', data());
    expect(execute).toHaveBeenCalledWith(
      expect.stringMatching(/^INSERT INTO user_sessions.*VALUES/s),
      [
        'new-login',
        expect.any(Number),
        expect.any(String),
        null,
        expect.any(Number),
        expect.any(Number),
        expect.any(Number),
      ],
    );
  });

  it('keeps a rolling eight-hour renewal for live sessions', async () => {
    const before = Date.now();
    await write('touch');
    const params = execute.mock.calls[0][1];
    expect(params[0]).toBeGreaterThanOrEqual(before + SESSION_MAX_AGE);
    expect(params[0]).toBeLessThanOrEqual(Date.now() + SESSION_MAX_AGE);
  });

  const authenticated = () =>
    ({ ...data(), user: { id: '42' } }) as session.SessionData;

  it.each(['recordContact', 'recordActivity'] as const)(
    '%s uses server time and conditional monotonic metadata SQL only',
    async (method) => {
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now);
      await store[method]('sid', authenticated());
      const [sql, params] = execute.mock.calls[0];
      expect(sql).toMatch(
        /GREATEST\(COALESCE\(last_(?:seen_at|active_time), 0\), \?\)/,
      );
      expect(sql).toContain('WHERE session_id = ? AND expires_at > ?');
      expect(sql).not.toMatch(/SET expires_at|data =|INSERT|UPSERT/);
      expect(params).toEqual([now, 'sid', now, now - 30000]);
    },
  );

  it('carries bigint metadata through session creation without serializing it into JSON', async () => {
    const now = Date.now();
    execute.mockResolvedValueOnce([
      [
        {
          data: JSON.stringify(authenticated()),
          expires_at: now + SESSION_MAX_AGE,
          last_seen_at: String(now),
          last_active_time: String(now),
        },
      ],
    ]);
    const loaded = await get('sid');
    const request = {} as never;
    const live = store.createSession(request, loaded);
    execute.mockClear();
    await store.recordContact('sid', live);
    await store.recordActivity('sid', live);
    expect(execute).not.toHaveBeenCalled();
    expect(JSON.stringify(live)).not.toMatch(/last_seen_at|last_active_time/);
  });

  it.each(['recordContact', 'recordActivity'] as const)(
    '%s rechecks a throttled write and rejects a deleted session',
    async (method) => {
      execute
        .mockResolvedValueOnce([{ affectedRows: 0 }])
        .mockResolvedValueOnce([[]]);
      await expect(
        store[method]('revoked', authenticated()),
      ).rejects.toBeInstanceOf(SessionExpiredError);
      expect(execute.mock.calls[1][0]).toContain('SELECT expires_at');
    },
  );

  it.each(['recordContact', 'recordActivity'] as const)(
    '%s accepts a write already performed by another process',
    async (method) => {
      execute
        .mockResolvedValueOnce([{ affectedRows: 0 }])
        .mockResolvedValueOnce([
          [{ expires_at: Date.now() + SESSION_MAX_AGE }],
        ]);
      await expect(
        store[method]('live', authenticated()),
      ).resolves.toBeUndefined();
    },
  );

  it.each(['recordContact', 'recordActivity'] as const)(
    '%s rejects unauthenticated or expired snapshots before writing',
    async (method) => {
      await expect(store[method]('anonymous', data())).rejects.toBeInstanceOf(
        SessionExpiredError,
      );
      const expired = authenticated();
      expired.cookie.expires = new Date(Date.now() - 1);
      await expect(store[method]('expired', expired)).rejects.toBeInstanceOf(
        SessionExpiredError,
      );
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it.each(['logout', 'revoked', 'replaced', 'expired'] as const)(
    'terminates %s atomically without overwriting an earlier end',
    async (reason) => {
      await store.endSession('sid', reason);
      const [sql, params] = execute.mock.calls[0];
      expect(sql).toContain('ended_at = LEAST(expires_at, ?)');
      expect(sql).toContain(
        "CASE WHEN expires_at <= ? THEN 'expired' ELSE ? END",
      );
      expect(sql).toContain('WHERE session_id = ? AND ended_at IS NULL');
      expect(sql).toContain('JSON_VALID(data)');
      expect(sql).toContain('$.audit.userId');
      expect(sql).toContain('$.user.id');
      expect(sql).not.toMatch(/DELETE|INSERT|amppAccess|amppCookie/);
      expect(params[2]).toBe(reason);
      expect(params[4]).toBe('sid');
      expect(sql.includes('AND expires_at <= ?')).toBe(reason === 'expired');
    },
  );

  it('captures immutable identity at login without copying credentials', async () => {
    const login = {
      ...data(),
      user: {
        id: '42',
        username: 'original',
        displayName: 'Original client',
        clientId: 7,
        userType: 'user' as const,
      },
      amppAccessToken: 'SECRET',
    } as session.SessionData;
    await store.create('sid', login);
    login.user.username = 'renamed';
    expect(login.audit).toEqual({
      userId: '42',
      username: 'original',
      displayName: 'Original client',
      clientId: 7,
      userType: 'user',
    });
    expect(JSON.stringify(login.audit)).not.toContain('SECRET');
  });

  it('cleans abandoned sessions periodically in bounded batches and stops on close', async () => {
    await store.close();
    jest.useFakeTimers();
    const options = { port: 3306, touchIntervalMs: 0 };
    store = new MysqlSessionStore(options);
    await store.create('new-login', data());
    execute.mockClear();
    await jest.advanceTimersByTimeAsync(60000);
    expect(execute).toHaveBeenCalledWith(
      expect.stringMatching(
        /UPDATE.*ended_at = expires_at.*WHERE ended_at IS NULL AND expires_at <= \? LIMIT 1000/s,
      ),
      [expect.any(Number)],
    );
    await store.close();
    execute.mockClear();
    await jest.advanceTimersByTimeAsync(60000);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([-1, 1.5, NaN, Infinity, SESSION_MAX_AGE])(
    'rejects an invalid renewal interval of %s',
    (touchIntervalMs) => {
      const options = { port: 3306, touchIntervalMs };
      expect(() => new MysqlSessionStore(options)).toThrow(
        'SESSION_TOUCH_INTERVAL_MS',
      );
    },
  );
});
