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
    store = new MysqlSessionStore({ port: 3306 });
    // Await initialization through the same public path used by login.
    await store.create('initial', data());
    execute.mockClear();
  });

  afterEach(async () => {
    await store.close();
    jest.useRealTimers();
  });

  it('deletes an encountered expired row without deleting a concurrent renewal', async () => {
    execute.mockResolvedValueOnce([[]]);
    expect(await get('expired')).toBeNull();
    expect(execute).toHaveBeenLastCalledWith(
      expect.stringMatching(/DELETE.*session_id = \? AND expires_at <= \?/s),
      ['expired', expect.any(Number)],
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
      ['new-login', expect.any(Number), expect.any(String)],
    );
  });

  it('keeps a rolling eight-hour renewal for live sessions', async () => {
    const before = Date.now();
    await write('touch');
    const params = execute.mock.calls[0][1];
    expect(params[0]).toBeGreaterThanOrEqual(before + SESSION_MAX_AGE);
    expect(params[0]).toBeLessThanOrEqual(Date.now() + SESSION_MAX_AGE);
  });

  it('cleans abandoned sessions periodically in bounded batches and stops on close', async () => {
    await store.close();
    jest.useFakeTimers();
    store = new MysqlSessionStore({ port: 3306 });
    await store.create('new-login', data());
    execute.mockClear();
    await jest.advanceTimersByTimeAsync(60000);
    expect(execute).toHaveBeenCalledWith(
      'DELETE FROM user_sessions WHERE expires_at <= ? LIMIT 1000',
      [expect.any(Number)],
    );
    await store.close();
    execute.mockClear();
    await jest.advanceTimersByTimeAsync(60000);
    expect(execute).not.toHaveBeenCalled();
  });
});
