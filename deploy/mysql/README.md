# MySQL logging for the dedicated development test server

Keep the existing 39 GB root filesystem. This profile disables MySQL binary
logging on a dedicated, disposable AMVVPP development instance with no
replication or point-in-time recovery requirement.
Normal InnoDB persistence, crash recovery, and MySQL error logging remain enabled.

`dev-test.cnf` is MySQL server configuration, not an API `.env` setting.
It covers both SPA Proxy and Admin writes on that instance. Deploying this
repository alone does not install the profile or change the running server.
Do not install it on a shared, replicated, CDC, or recovery-dependent instance.
The Admin repository has replication-monitor code used by other deployments.

## Incident and scope

The November 3, 2026 incident was caused by a full root filesystem. MySQL
connection 151 repeatedly reported `OS errno 28` writing `binlog.000306`,
remained in `ACTIVE (PREPARED)` during commit, and held a primary-key lock
on `AMVVPP.user_sessions`. Concurrent renewal writes occupied all ten
session-store connections; additional browsers' session operations queued.

The session store renews expiry on request completion and explicitly saves
the session endpoint's rolling deadline before responding. Session rows
contain a `LONGTEXT` JSON payload. MySQL's `ROW`/`FULL` logging can copy
that payload before and after even an expiry-only update. The application
database measured 12 MB while the MySQL directory used 28 GB; the precise
retained binary-log total was not supplied.

Disabling binary logging eliminates new binary-log history for this dev
instance. It does not impose a cap on database growth or other files.
The configuration adds no schema changes or log-management privileges to
the web apps. Existing session/permission contracts and InnoDB durability
settings remain in use. No application code changes are required.

## Recover space before disabling binary logging

1. Stop test traffic from both apps so recovery does not compete with
   new writes. Keep MySQL running initially.
2. Establish headroom outside the MySQL data directory. In the incident,
   `/var/cache/apt` held about 250 MB of downloaded package archives:

   ```sh
   sudo apt-get clean
   df -h /
   ```

   This removes cached package downloads without uninstalling packages.
   If it frees no space, identify another disposable non-database cache;
   do not remove MySQL data, redo, undo, or binary-log files by hand.
3. While binary logging is still enabled, run the recovery SQL using your
   existing administrative MySQL login. It removes old binary-log history
   from this confirmed disposable instance, retaining the current file:

   ```sql
   SHOW BINARY LOG STATUS;
   PURGE BINARY LOGS BEFORE CURRENT_TIMESTAMP;
   SHOW BINARY LOGS;
   SELECT waiting_pid, blocking_pid, locked_table, wait_age
   FROM sys.innodb_lock_waits;
   ```

   The purge does not delete application table rows or reset GTIDs.
   A purge may itself fail if the disk has no working space, which is why
   initial headroom matters. If space is restored, the incident's MySQL
   log reports retrying the blocked write every 60 seconds. Confirm the
   commit and lock waits clear, and check `df -h /` before proceeding.
   If the purge fails, stop and inspect its error rather than deleting files.

Disabling binary logging does not delete its old files. Purge first:
`PURGE BINARY LOGS` has no effect if the server started without logging.

## Install on ampp-app01

From the SPA Proxy checkout on the MySQL host:

```sh
sudo install -m 0644 deploy/mysql/dev-test.cnf \
  /etc/mysql/mysql.conf.d/zz-amvvpp-dev-test.cnf
sudo mysqld --validate-config
```

Require configuration validation to succeed before restarting:

```sh
sudo systemctl restart mysql
```

Use a normal shutdown/restart after the disk-full commit clears. A restart
with binary logging disabled after an abnormal shutdown can skip binary-log
GTID recovery. Do not force-kill MySQL to apply the profile.

Check effective settings because a later command-line or configuration
option can override `skip-log-bin`:

```sql
SHOW GLOBAL VARIABLES WHERE Variable_name IN (
  'log_bin', 'innodb_flush_log_at_trx_commit'
);
SELECT waiting_pid, blocking_pid, locked_table, wait_age
FROM sys.innodb_lock_waits;
```

Require `log_bin=OFF` and retain the existing
`innodb_flush_log_at_trx_commit=1`. Confirm usable free space with `df -h /`.
Restart the test apps, verify login, and run the usual long-duration GVUI
test while observing disk usage. The existing current binlog may remain
on disk; new binary logs should not be generated.

This profile must be validated on the actual test server. MySQL was not
available in the code workspace, so the server's validation and live
acceptance steps above are still required. No app build or session code
changes are part of this configuration.

## Rollback

Record the original effective settings before installation. To undo the
profile, remove only `/etc/mysql/mysql.conf.d/zz-amvvpp-dev-test.cnf`,
validate configuration, and restart MySQL normally. Binary logging returns
to the previous configuration; purged history cannot be recovered by
removing the profile. Reintroduce an explicit retention/storage policy
before using a binary-logging configuration for prolonged tests.

References:

- [Binary logging and startup options](https://dev.mysql.com/doc/refman/8.4/en/replication-options-binary-log.html)
- [Binary-log purge](https://dev.mysql.com/doc/refman/8.4/en/purge-binary-logs.html)
- [Server configuration validation](https://dev.mysql.com/doc/refman/8.4/en/server-configuration-validation.html)
