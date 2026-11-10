// Run after the API build against a disposable, loopback-only MySQL 8 server:
// node test/session-metadata-mysql.cjs PORT
// The database name is deliberately fixed; no application DB settings are read.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const session = require('express-session');
const { createPool } = require('mysql2/promise');
const {
  MysqlSessionStore,
  SessionExpiredError,
} = require('../dist/auth/mysql-session.store');
const { SESSION_MAX_AGE } = require('../dist/auth/session-cookie');
const port = Number(process.argv[2]);
assert.ok(Number.isInteger(port) && port > 0, 'Pass the disposable MySQL port');
const options = {
  host: '127.0.0.1',
  port,
  user: 'root',
  password: '',
  database: 'session_metadata_test',
};

(async () => {
  const pool = createPool(options);
  const stores = [];
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    await pool.execute('DROP TABLE IF EXISTS user_sessions');
    await pool.execute('DROP TABLE IF EXISTS metadata_updates');
    const store = new MysqlSessionStore(options);
    const second = new MysqlSessionStore(options);
    stores.push(store, second);
    const data = {
      cookie: new session.Cookie({ maxAge: SESSION_MAX_AGE }),
      user: {
        id: '42',
        username: 'original',
        displayName: 'Original client',
        clientId: 7,
        userType: 'user',
      },
    };
    await store.create('login', data, '2001:db8::42');
    const load = (from = store) =>
      new Promise((resolve, reject) =>
        from.get('login', (error, value) =>
          error ? reject(error) : resolve(value),
        ),
      );
    const row = async () =>
      (
        await pool.execute('SELECT * FROM user_sessions WHERE session_id = ?', [
          'login',
        ])
      )[0][0];
    const login = await row();
    assert.equal(login.ip_address, '2001:db8::42');
    for (const field of ['started_at', 'last_seen_at', 'last_active_time'])
      assert.equal(Number(login[field]), now);
    const [columns] = await pool.execute('SHOW COLUMNS FROM user_sessions');
    const [indexes] = await pool.execute('SHOW INDEX FROM user_sessions');
    for (const name of ['idx_user_sessions_ended_expires', 'idx_user_sessions_started_at'])
      assert.ok(indexes.some((index) => index.Key_name === name));
    for (const field of [
      'ip_address',
      'started_at',
      'last_seen_at',
      'last_active_time',
      'ended_at',
      'end_reason',
    ])
      assert.equal(
        columns.find((column) => column.Field === field).Null,
        'YES',
      );

    await pool.execute(
      'CREATE TABLE metadata_updates (field VARCHAR(32), at_ms BIGINT UNSIGNED)',
    );
    await pool.query(`CREATE TRIGGER capture_metadata AFTER UPDATE ON user_sessions FOR EACH ROW
      BEGIN
        IF NOT (OLD.last_seen_at <=> NEW.last_seen_at) THEN
          INSERT INTO metadata_updates VALUES ('last_seen_at', NEW.last_seen_at);
        END IF;
        IF NOT (OLD.last_active_time <=> NEW.last_active_time) THEN
          INSERT INTO metadata_updates VALUES ('last_active_time', NEW.last_active_time);
        END IF;
      END`);
    const started = now;
    now += 29999;
    await store.recordContact('login', await load());
    assert.equal(Number((await row()).last_seen_at), started);
    now++;
    const snapshots = await Promise.all([load(), load(second)]);
    await Promise.all(
      stores.map((from, index) =>
        from.recordContact('login', snapshots[index]),
      ),
    );
    await Promise.all(
      stores.map((from, index) =>
        from.recordActivity('login', snapshots[index]),
      ),
    );
    const [writes] = await pool.execute(
      'SELECT field, COUNT(*) AS count FROM metadata_updates GROUP BY field',
    );
    assert.equal(writes.length, 2);
    for (const write of writes) assert.equal(Number(write.count), 1);
    const tracked = await row();
    assert.equal(Number(tracked.last_seen_at), now);
    assert.equal(Number(tracked.last_active_time), now);
    assert.equal(Number(tracked.started_at), started);
    assert.equal(
      Number(tracked.expires_at),
      Number(login.expires_at),
      'metadata must not renew expiry',
    );

    await pool.execute(
      'UPDATE user_sessions SET ip_address=NULL, started_at=NULL, last_seen_at=NULL, last_active_time=NULL',
    );
    const stale = await load();
    now = started + 90000;
    await second.recordActivity('login', await load(second));
    now = started + 60000;
    await store.recordActivity('login', stale);
    assert.equal(
      Number((await row()).last_active_time),
      started + 90000,
      'a stale writer cannot move time backwards',
    );
    await store.recordContact('login', await load());
    const legacy = await row();
    assert.equal(legacy.started_at, null);
    assert.equal(legacy.ip_address, null);
    const save = (method, value) =>
      new Promise((resolve, reject) =>
        store[method]('login', value, (error) =>
          error ? reject(error) : resolve(),
        ),
      );
    await save('set', await load());
    assert.equal(
      Number((await row()).last_active_time),
      started + 90000,
      'ordinary JSON saves preserve tracking columns',
    );

    const beforeLogout = await load();
    const loginAudit = { ...beforeLogout.audit };
    beforeLogout.user.username = 'renamed';
    beforeLogout.user.displayName = 'Renamed client';
    beforeLogout.amppAccessToken = 'AUDIT_SECRET';
    beforeLogout.amppCookieJar = { cookies: [{ value: 'AUDIT_SECRET' }] };
    beforeLogout.audit.secret = 'AUDIT_SECRET';
    await save('set', beforeLogout);
    now += 60000;
    await store.endSession('login', 'logout');
    await new Promise((resolve, reject) =>
      store.destroy('login', (error) => (error ? reject(error) : resolve())),
    );
    await assert.rejects(
      store.recordContact('login', beforeLogout),
      SessionExpiredError,
    );
    await assert.rejects(
      store.recordActivity('login', beforeLogout),
      SessionExpiredError,
    );
    await assert.rejects(save('set', beforeLogout), SessionExpiredError);
    await assert.rejects(save('touch', beforeLogout), SessionExpiredError);
    const ended = await row();
    assert.equal(Number(ended.ended_at), now);
    assert.equal(Number(ended.expires_at), now);
    assert.equal(ended.end_reason, 'logout');
    assert.deepEqual(JSON.parse(ended.data), { audit: loginAudit });
    assert.ok(!ended.data.includes('AUDIT_SECRET'));
    now += 60000;
    await second.endSession('login', 'replaced');
    await store.endSession('login', 'expired');
    assert.equal(await load(), null);
    assert.deepEqual(
      await row(),
      ended,
      'repeated endings and stale cookies preserve history',
    );

    const deadline = now - 2000;
    await pool.execute(
      'INSERT INTO user_sessions (session_id,expires_at,data) VALUES (?,?,?)',
      ['corrupt', deadline, 'invalid json'],
    );
    await new Promise((resolve, reject) =>
      store.get('corrupt', (error, value) =>
        error ? reject(error) : resolve(value),
      ),
    );
    const [[corrupt]] = await pool.execute(
      'SELECT * FROM user_sessions WHERE session_id=?',
      ['corrupt'],
    );
    assert.equal(Number(corrupt.ended_at), deadline);
    assert.equal(corrupt.end_reason, 'expired');
    assert.deepEqual(JSON.parse(corrupt.data), {
      audit: {
        userId: null,
        username: null,
        displayName: null,
        clientId: null,
        userType: null,
      },
    });

    for (const reason of ['revoked', 'replaced']) {
      await store.create(reason, {
        cookie: new session.Cookie({ maxAge: SESSION_MAX_AGE }),
        user: { ...data.user },
      });
      if (reason === 'revoked')
        await new Promise((resolve, reject) =>
          store.destroy(reason, (error) => (error ? reject(error) : resolve())),
        );
      else await store.endSession(reason, reason);
      const [[finished]] = await pool.execute(
        'SELECT * FROM user_sessions WHERE session_id=?',
        [reason],
      );
      assert.equal(finished.end_reason, reason);
      assert.equal(Number(finished.ended_at), now);
    }

    await store.create('race', {
      cookie: new session.Cookie({ maxAge: SESSION_MAX_AGE }),
      user: { ...data.user },
    });
    const pending = await new Promise((resolve, reject) =>
      store.get('race', (error, value) =>
        error ? reject(error) : resolve(value),
      ),
    );
    pending.amppAccessToken = 'RACE_SECRET';
    await Promise.allSettled([
      store.endSession('race', 'logout'),
      new Promise((resolve, reject) =>
        second.set('race', pending, (error) =>
          error ? reject(error) : resolve(),
        ),
      ),
    ]);
    const [[raced]] = await pool.execute(
      'SELECT * FROM user_sessions WHERE session_id=?',
      ['race'],
    );
    assert.equal(raced.end_reason, 'logout');
    assert.ok(!raced.data.includes('RACE_SECRET'));

    // Apply the exact migration to the prior session schema with live data.
    await Promise.all(stores.splice(0).map((active) => active.close()));
    await pool.execute('DROP TABLE user_sessions');
    await pool.execute(`CREATE TABLE user_sessions (
      session_id VARCHAR(128) PRIMARY KEY, expires_at BIGINT UNSIGNED NOT NULL, data LONGTEXT NOT NULL,
      ip_address VARCHAR(45) NULL, started_at BIGINT UNSIGNED NULL,
      last_active_time BIGINT UNSIGNED NULL, last_seen_at BIGINT UNSIGNED NULL,
      INDEX idx_user_sessions_expires_at (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    const legacyPayload = JSON.stringify({
      cookie: new session.Cookie({ maxAge: SESSION_MAX_AGE }),
      user: data.user,
      amppAccessToken: 'LEGACY_SECRET',
    });
    await pool.execute(
      'INSERT INTO user_sessions (session_id,expires_at,data) VALUES (?,?,?)',
      ['legacy-active', now + 60000, legacyPayload],
    );
    await pool.execute(
      'INSERT INTO user_sessions (session_id,expires_at,data) VALUES (?,?,?)',
      ['legacy-expired', now - 10000, legacyPayload],
    );
    await pool.query(
      fs.readFileSync(
        path.resolve(
          __dirname,
          '../migrations/20261110-session-audit-retention.sql',
        ),
        'utf8',
      ),
    );
    const [[migrated]] = await pool.execute(
      'SELECT * FROM user_sessions WHERE session_id=?',
      ['legacy-active'],
    );
    assert.equal(migrated.ended_at, null);
    assert.equal(migrated.end_reason, null);
    assert.equal(migrated.data, legacyPayload);
    const migrationStore = new MysqlSessionStore(options);
    stores.push(migrationStore);
    await new Promise((resolve, reject) =>
      migrationStore.get('legacy-active', (error, value) =>
        error ? reject(error) : resolve(value),
      ),
    );
    const [[expiredLegacy]] = await pool.execute(
      'SELECT * FROM user_sessions WHERE session_id=?',
      ['legacy-expired'],
    );
    assert.equal(Number(expiredLegacy.ended_at), now - 10000);
    assert.equal(expiredLegacy.end_reason, 'expired');
    assert.equal(expiredLegacy.started_at, null);
    assert.equal(expiredLegacy.ip_address, null);
    assert.equal(
      JSON.parse(expiredLegacy.data).audit.username,
      data.user.username,
    );
    assert.ok(!expiredLegacy.data.includes('LEGACY_SECRET'));
    await Promise.all(stores.splice(0).map((active) => active.close()));

    // No timers are running while inserting a batch larger than the per-pass cap.
    await pool.query(
      'INSERT INTO user_sessions (session_id,expires_at,data) VALUES ?',
      [
        Array.from({ length: 1001 }, (_, i) => [
          `batch-${i}`,
          now - 1,
          legacyPayload,
        ]),
      ],
    );
    for (const expected of [1000, 1001]) {
      const cleanup = new MysqlSessionStore(options);
      stores.push(cleanup);
      await new Promise((resolve, reject) =>
        cleanup.get('missing', (error) => (error ? reject(error) : resolve())),
      );
      const [[count]] = await pool.execute(
        "SELECT COUNT(*) AS count FROM user_sessions WHERE session_id LIKE 'batch-%' AND ended_at IS NOT NULL",
      );
      assert.equal(Number(count.count), expected);
      await Promise.all(stores.splice(0).map((active) => active.close()));
    }
    const [[total]] = await pool.execute(
      'SELECT COUNT(*) AS count FROM user_sessions',
    );
    assert.equal(
      Number(total.count),
      1003,
      'cleanup retains every historical row',
    );
    const [[version]] = await pool.execute('SELECT VERSION() AS version');
    console.log(
      `PASS MySQL ${version.version}: bootstrap + additive migration, metadata throttling, retained logout/expiry/revocation/replacement, immutable identity, credential removal, concurrent saves, corrupt JSON, 1000-row cleanup cap`,
    );
  } finally {
    Date.now = realNow;
    await Promise.all(stores.map((store) => store.close()));
    await pool.end();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
