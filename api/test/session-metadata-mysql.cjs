// Run after the API build against a disposable, loopback-only MySQL 8 server:
// node test/session-metadata-mysql.cjs PORT
// The database name is deliberately fixed; no application DB settings are read.
const assert = require('node:assert/strict');
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
      user: { id: '42' },
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
    for (const field of [
      'ip_address',
      'started_at',
      'last_seen_at',
      'last_active_time',
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
    now += 60000;
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
    assert.equal(await row(), undefined);
    const [[version]] = await pool.execute('SELECT VERSION() AS version');
    console.log(
      `PASS MySQL ${version.version}: nullable bootstrap schema, login metadata, concurrent throttling, monotonicity, legacy NULLs, JSON-save isolation, revocation`,
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
