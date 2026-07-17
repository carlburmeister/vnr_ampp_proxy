import session from 'express-session';
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
};

export class MysqlSessionStore extends session.Store {
  private readonly pool: Pool;
  private readonly ready: Promise<void>;

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

    this.ready = this.createTable();
  }

  async get(
    sid: string,
    callback: (error: any, session?: session.SessionData | null) => void,
  ) {
    try {
      await this.ready;
      await this.deleteExpiredSessions();

      const [rows] = await this.pool.execute<SessionRow[]>(
        `SELECT data
         FROM user_sessions
         WHERE session_id = ? AND expires_at > ?
         LIMIT 1`,
        [sid, Date.now()],
      );

      if (!rows.length) {
        callback(null, null);
        return;
      }

      callback(null, JSON.parse(rows[0].data) as session.SessionData);
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

      await this.pool.execute<ResultSetHeader>(
        `INSERT INTO user_sessions (session_id, expires_at, data)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE expires_at = VALUES(expires_at), data = VALUES(data)`,
        [sid, this.getExpiresAt(sessionData), JSON.stringify(sessionData)],
      );

      callback?.();
    } catch (error) {
      callback?.(error);
    }
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

      await this.pool.execute<ResultSetHeader>(
        `UPDATE user_sessions SET expires_at = ? WHERE session_id = ?`,
        [this.getExpiresAt(sessionData), sid],
      );

      callback?.();
    } catch (error) {
      callback?.(error);
    }
  }

  async close() {
    await this.pool.end();
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
      `DELETE FROM user_sessions WHERE expires_at <= ?`,
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

    return Date.now() + 1000 * 60 * 60 * 8;
  }
}