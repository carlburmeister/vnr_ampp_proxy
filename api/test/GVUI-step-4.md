# GVUI permission contracts

These contracts remain in effect after step 7. Current deployment and combined
UI acceptance instructions are in [GVUI-step-7.md](GVUI-step-7.md).

The shared database must have the Admin repository's
`db_schema/gvui_20261023/update.sql` installed and verified with its `check.sql`.
The required tables are `ampp_gvui_layouts`, `client_user_gvui_permissions` and
`client_gvui_denials`. GVUI is a permanent capability; table access is required
and database/schema failures propagate rather than silently granting access.

- `GET /api/user-management/resources` returns `gvuiLayouts` with integer
  assignment `id`, AMPP UUID `layoutId`, `name` and nullable
  `associatedWorkloadId`. Only same-client, non-restricted assignments are listed.
- `GET /api/user-management/users/:userId/permissions` returns `gvuiLayoutIds`
  using assignment row IDs, excluding client-restricted assignments/associations.
- `PUT` accepts optional `gvuiLayoutIds`. Omission preserves raw grants, including
  hidden restricted grants. Explicit `[]` clears them. Null, malformed IDs and
  arrays larger than 500 are rejected. Existing workload/dashboard/child fields
  remain required. Saves are atomic across all permission categories.
- Client-admin role and client ownership are rechecked after acquiring the same
  client-row lock used by Admin. Layouts and client restrictions are validated
  inside the transaction. Grant creator IDs reference the acting client user.
- `GET /api/ampp/session/current` returns `allowedGvuiLayoutIds` (AMPP UUIDs) and
  `allowedGvuiLayouts` (`id`, `name`, `associatedWorkloadId`). Effective layouts
  require explicit same-client grants; client restrictions take precedence.
  Associated layouts also require effective access to their associated workload.
  Layout grants never expand workload or dashboard permissions.

GVUI identity, names and associations participate in authorization fingerprints.
Permission refresh uses `AUTH_PERMISSION_REFRESH_INTERVAL_MS` (default 10000 ms)
on guarded requests. Old authorization snapshots force an immediate rebuild when
upgrading to the permanent implementation. Concurrent proxy cache saves copy the
newer authorization snapshot and cannot restore revoked grants.

Isolated transaction and HTTP tests cover grant/clear, legacy omission, malformed
bodies, role/client checks, denial precedence, rollback and shared lock ordering.
Actual MySQL semantics and locking still require local acceptance. No test creates
accounts or applies a schema to a live database.
