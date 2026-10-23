import session from 'express-session';
import { Logger } from '@nestjs/common';
import { SESSION_MAX_AGE } from './session-cookie';
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
};

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
  private readonly pool: Pool;
  private readonly ready: Promise<void>;
  private readonly cleanupTimer: NodeJS.Timeout;
  private cleaning = false;

  constructor(options: MysqlSessionStoreOptions) {
    super();

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
      await this.ready;

      const [result] = await this.pool.execute<ResultSetHeader>(
        `UPDATE user_sessions
         SET expires_at = GREATEST(expires_at, ?), data = ?
         WHERE session_id = ? AND expires_at > ?`,
        [
          this.getExpiresAt(sessionData),
          JSON.stringify(sessionData),
          sid,
          Date.now(),
        ],
      );
      if (!result.affectedRows) throw new SessionExpiredError();

      callback?.();
    } catch (error) {
      callback?.(error);
    }
  }

  async create(sid: string, sessionData: session.SessionData) {
    await this.ready;
    await this.pool.execute<ResultSetHeader>(
      `INSERT INTO user_sessions (session_id, expires_at, data) VALUES (?, ?, ?)`,
      [sid, this.getExpiresAt(sessionData), JSON.stringify(sessionData)],
    );
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
      await this.ready;

      const [result] = await this.pool.execute<ResultSetHeader>(
        `UPDATE user_sessions SET expires_at = GREATEST(expires_at, ?)
         WHERE session_id = ? AND expires_at > ?`,
        [this.getExpiresAt(sessionData), sid, Date.now()],
      );
      if (!result.affectedRows) throw new SessionExpiredError();

      callback?.();
    } catch (error) {
      callback?.(error);
    }
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
