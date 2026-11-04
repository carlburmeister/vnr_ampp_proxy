import type { SessionData } from 'express-session';

export const GVUI_MAILBOX_LIMIT = 512;
export const GVUI_ACTIVITY_INTERVAL_MS = 60000;
export const GVUI_MAILBOX_IDLE_MS = 1500000 + GVUI_ACTIVITY_INTERVAL_MS;

export function pruneGvuiMailboxes(
  session: SessionData,
  now = Date.now(),
): void {
  if (session.allowedGvuiLayoutIds === undefined) return;
  const reclaimIdle =
    Object.keys(session.gvuiMailboxes ?? {}).length >= GVUI_MAILBOX_LIMIT;
  for (const [alias, entry] of Object.entries(session.gvuiMailboxes ?? {})) {
    if (!session.allowedGvuiLayoutIds?.includes(entry.contextId.slice(5))) {
      delete session.gvuiMailboxes[alias];
    } else if (entry.lastUsedAt === undefined) {
      // Legacy sessions have no inactivity evidence. Observe one idle window
      // before reclaiming them instead of mistaking an old active tab for idle.
      entry.lastUsedAt = now;
    } else if (reclaimIdle && now - entry.lastUsedAt >= GVUI_MAILBOX_IDLE_MS) {
      delete session.gvuiMailboxes[alias];
    }
  }
}
