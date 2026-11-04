import session from 'express-session';
import { Logger } from '@nestjs/common';
import { SESSION_MAX_AGE } from './session-cookie';
import type { Request } from 'express';
import {
  createPool,
  type Pool,
  type ResultSetHeader,
  type RowDataPacket,
} from 'mysql2/promise';

export type MysqlSessionStoreOptions = {
  host?: string;
  port: number;
  user?: string;
  password?: string;
  database?: string;
  touchIntervalMs?: number;
};

export const DEFAULT_SESSION_TOUCH_INTERVAL_MS = 60000;

type SessionRow = RowDataPacket & {
  data: string;
  expires_at: number;
};

export class SessionExpiredError extends Error {
  constructor() {
    super('Session expired or revoked');
  }
}

export class MysqlSessionStore extends session.Store {
  readonly touchIntervalMs: number;
  private readonly pool: Pool;
  private readonly ready: Promise<void>;
  private readonly cleanupTimer: NodeJS.Timeout;
  private cleaning = false;
  private readonly completedPolls = new WeakMap<
    session.SessionData,
    { sid: string; expiresAt: number }
  >();
  private readonly confirmedDeadlines = new WeakMap<
    session.SessionData,
    number
  >();

  constructor(options: MysqlSessionStoreOptions) {
    super();

    this.touchIntervalMs =
      options.touchIntervalMs ?? DEFAULT_SESSION_TOUCH_INTERVAL_MS;
    if (
      !Number.isSafeInteger(this.touchIntervalMs) ||
      this.touchIntervalMs < 0 ||
      this.touchIntervalMs >= SESSION_MAX_AGE
    ) {
      throw new Error(
        'SESSION_TOUCH_INTERVAL_MS must be an integer from 0 to less than eight hours',
      );
    }

    this.pool = createPool({
      host: options.host,
      port: options.port,
      user: options.user,
      password: options.password,
      database: options.database,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    });

    this.ready = this.initialize();
    this.cleanupTimer = setInterval(() => {
      if (this.cleaning) return;
      this.cleaning = true;
      void this.ready
        .then(() => this.deleteExpiredSessions())
        .catch(() =>
          Logger.warn(
            'Expired session cleanup failed; will retry',
            'MysqlSessionStore',
          ),
        )
        .finally(() => {
          this.cleaning = false;
        });
    }, 60000);
    this.cleanupTimer.unref();
  }

  createSession(req: Request, data: session.SessionData) {
    const loaded = super.createSession(req, data);
    this.confirmExpiry(loaded, this.getExpiresAt(loaded));
    return loaded;
  }

  confirmedExpiry(data?: session.SessionData): number | undefined {
    return data ? this.confirmedDeadlines.get(data) : undefined;
  }

  async get(
    sid: string,
    callback: (error: any, session?: session.SessionData | null) => void,
  ) {
    try {
      await this.ready;

      const [rows] = await this.pool.execute<SessionRow[]>(
        `SELECT data, expires_at
         FROM user_sessions
         WHERE session_id = ? AND expires_at > ?
         LIMIT 1`,
        [sid, Date.now()],
      );

      if (!rows.length) {
        // The predicate also protects a session renewed by a concurrent request.
        await this.pool.execute<ResultSetHeader>(
          `DELETE FROM user_sessions WHERE session_id = ? AND expires_at <= ?`,
          [sid, Date.now()],
        );
        callback(null, null);
        return;
      }

      const data = JSON.parse(rows[0].data) as session.SessionData;
      // touch() renews the indexed deadline without rewriting the JSON blob.
      data.cookie.expires = new Date(Number(rows[0].expires_at));
      callback(null, data);
    } catch (error) {
      callback(error);
    }
  }

  async set(
    sid: string,
    sessionData: session.SessionData,
    callback?: (error?: any) => void,
  ) {
    try {
      // A later explicit/data save must retain its normal finalization behavior.
      this.completedPolls.delete(sessionData);
      await this.ready;
      const expiresAt = this.getExpiresAt(sessionData);

      const [result] = await this.pool.execute<ResultSetHeader>(
        `UPDATE user_sessions
         SET expires_at = GREATEST(expires_at, ?), data = ?
         WHERE session_id = ? AND expires_at > ?`,
        [expiresAt, JSON.stringify(sessionData), sid, Date.now()],
      );
      if (!result.affectedRows) throw new SessionExpiredError();
      this.confirmExpiry(sessionData, expiresAt);
      if (this.touchIntervalMs > 0) {
        this.completedPolls.set(sessionData, { sid, expiresAt });
      }

      callback?.();
    } catch (error) {
      callback?.(error);
    }
  }

  async persistCurrentPoll(
    sid: string,
    sessionData: session.Session,
    authorizationChanged: boolean,
  ): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      const done = (error?: Error) => (error ? reject(error) : resolve());
      if (authorizationChanged) sessionData.save(done);
      else void this.touch(sid, sessionData, done);
    });
    const expiresAt = this.getExpiresAt(sessionData);
    // Session objects are unique to a request; never suppress another tab's write.
    this.completedPolls.set(sessionData, { sid, expiresAt });
    return expiresAt;
  }

  renewForResponse(sid: string, data: session.Session): Promise<number> {
    data.touch();
    return this.persistCurrentPoll(sid, data, false);
  }

  async create(sid: string, sessionData: session.SessionData) {
    await this.ready;
    const expiresAt = this.getExpiresAt(sessionData);
    await this.pool.execute<ResultSetHeader>(
      `INSERT INTO user_sessions (session_id, expires_at, data) VALUES (?, ?, ?)`,
      [sid, expiresAt, JSON.stringify(sessionData)],
    );
    this.confirmExpiry(sessionData, expiresAt);
  }

  async destroy(sid: string, callback?: (error?: any) => void) {
    try {
      await this.ready;

      await this.pool.execute<ResultSetHeader>(
        `DELETE FROM user_sessions WHERE session_id = ?`,
        [sid],
      );

      callback?.();
    } catch (error) {
      callback?.(error);
    }
  }

  async touch(
    sid: string,
    sessionData: session.SessionData,
    callback?: (error?: any) => void,
  ) {
    try {
      const expiresAt = this.getExpiresAt(sessionData);
      const completed = this.completedPolls.get(sessionData);
      this.completedPolls.delete(sessionData);
      if (
        completed?.sid === sid &&
        completed.expiresAt > Date.now() &&
        (this.touchIntervalMs === 0 ||
          expiresAt - completed.expiresAt < this.touchIntervalMs)
      ) {
        // express-session touches again at res.end(). Use the deadline already
        // confirmed for this poll, including when it serializes the cookie.
        this.confirmExpiry(sessionData, completed.expiresAt);
        callback?.();
        return;
      }
      await this.ready;

      if (this.touchIntervalMs > 0) {
        const storedExpiry = await this.readExpiry(sid);
        if (expiresAt - storedExpiry < this.touchIntervalMs) {
          this.confirmExpiry(sessionData, storedExpiry);
          callback?.();
          return;
        }
        const [result] = await this.pool.execute<ResultSetHeader>(
          `UPDATE user_sessions SET expires_at = GREATEST(expires_at, ?)
           WHERE session_id = ? AND expires_at > ? AND expires_at <= ?`,
          [expiresAt, sid, Date.now(), expiresAt - this.touchIntervalMs],
        );
        // Another process may have renewed the row or deleted it after our read.
        this.confirmExpiry(
          sessionData,
          result.affectedRows
            ? Math.max(storedExpiry, expiresAt)
            : await this.readExpiry(sid),
        );
        callback?.();
        return;
      }

      const [result] = await this.pool.execute<ResultSetHeader>(
        `UPDATE user_sessions SET expires_at = GREATEST(expires_at, ?)
         WHERE session_id = ? AND expires_at > ?`,
        [expiresAt, sid, Date.now()],
      );
      if (!result.affectedRows) throw new SessionExpiredError();
      this.confirmExpiry(sessionData, expiresAt);

      callback?.();
    } catch (error) {
      callback?.(error);
    }
  }

  private async readExpiry(sid: string): Promise<number> {
    const [rows] = await this.pool.execute<
      (RowDataPacket & { expires_at: number })[]
    >(
      `SELECT expires_at FROM user_sessions
       WHERE session_id = ? AND expires_at > ? LIMIT 1`,
      [sid, Date.now()],
    );
    const expiresAt = Number(rows[0]?.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now())
      throw new SessionExpiredError();
    return expiresAt;
  }

  private confirmExpiry(data: session.SessionData, expiresAt: number): void {
    this.confirmedDeadlines.set(data, expiresAt);
    // Assigning Cookie.expires also resets originalMaxAge in express-session.
    // Retain the eight-hour rolling lifetime when reusing an older deadline.
    const maxAge = data.cookie.originalMaxAge;
    data.cookie.expires = new Date(expiresAt);
    data.cookie.originalMaxAge = maxAge;
  }

  async close() {
    clearInterval(this.cleanupTimer);
    await this.pool.end();
  }

  private async initialize() {
    await this.createTable();
    await this.deleteExpiredSessions();
  }

  private async createTable() {
    await this.pool.execute(
      `CREATE TABLE IF NOT EXISTS user_sessions (
        session_id VARCHAR(128) NOT NULL PRIMARY KEY,
        expires_at BIGINT UNSIGNED NOT NULL,
        data LONGTEXT NOT NULL,
        INDEX idx_user_sessions_expires_at (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    );
  }

  private async deleteExpiredSessions() {
    await this.pool.execute<ResultSetHeader>(
      `DELETE FROM user_sessions WHERE expires_at <= ? LIMIT 1000`,
      [Date.now()],
    );
  }

  private getExpiresAt(sessionData: session.SessionData) {
    if (sessionData.cookie?.expires) {
      return new Date(sessionData.cookie.expires).getTime();
    }

    if (typeof sessionData.cookie?.maxAge === 'number') {
      return Date.now() + sessionData.cookie.maxAge;
    }

    return Date.now() + SESSION_MAX_AGE;
  }
}
