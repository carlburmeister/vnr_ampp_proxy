// In-memory lifecycle model for the HTTP fixtures. Real MySQL checks separately
// execute the production SQL, including JSON sanitization and concurrent locks.
export type RetainedSessionRow = {
  expires_at: number;
  data: string;
  ended_at?: number | null;
  end_reason?: string | null;
};

export function applySessionEnding(
  sql: string,
  params: (string | number)[],
  rows: Map<string, RetainedSessionRow>,
): { affectedRows: number } | undefined {
  if (!/ended_at = (LEAST|expires_at)/.test(sql)) return;
  const batch = sql.includes('LIMIT 1000');
  const now = Number(params[0]);
  let count = 0;
  for (const [sid, row] of rows) {
    if (row.ended_at != null || (!batch && sid !== params[4])) continue;
    if ((batch || params[2] === 'expired') && row.expires_at > now) continue;
    if (count === 1000) break;
    const expired = row.expires_at <= now;
    row.ended_at = Math.min(row.expires_at, now);
    row.end_reason = expired ? 'expired' : String(params[2]);
    row.expires_at = row.ended_at;
    let payload: {
      audit?: Record<string, unknown>;
      user?: Record<string, unknown>;
    };
    try {
      payload = JSON.parse(row.data) as typeof payload;
    } catch {
      payload = {};
    }
    row.data = JSON.stringify({
      audit: Object.fromEntries(
        Object.entries({
          userId: 'id',
          username: 'username',
          displayName: 'displayName',
          clientId: 'clientId',
          userType: 'userType',
        }).map(([key, legacy]) => [
          key,
          payload.audit?.[key] ?? payload.user?.[legacy] ?? null,
        ]),
      ),
    });
    count++;
  }
  return { affectedRows: count };
}
