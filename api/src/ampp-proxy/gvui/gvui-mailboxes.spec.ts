import type { SessionData } from 'express-session';
import { GVUI_MAILBOX_IDLE_MS, pruneGvuiMailboxes } from './gvui-mailboxes';

const LAYOUT = '11111111-1111-4111-8111-111111111111';
const CONTEXT = `gvui-${LAYOUT}`;
const now = 10000000;
const entry = (lastUsedAt?: number) => ({
  contextId: CONTEXT,
  upstreamId: 'upstream',
  createdAt: 1,
  lastUsedAt,
});

describe('GVUI mailbox reclamation', () => {
  it('preserves active aliases regardless of creation age and reclaims recorded-idle aliases under pressure', () => {
    const session = {
      cookie: {} as SessionData['cookie'],
      allowedGvuiLayoutIds: [LAYOUT],
      gvuiMailboxes: {
        ...Object.fromEntries(
          Array.from({ length: 511 }, (_, i) => [`idle-${i}`, entry(1)]),
        ),
        active: entry(now),
      },
    } as SessionData;
    pruneGvuiMailboxes(session, now);
    expect(Object.keys(session.gvuiMailboxes)).toEqual(['active']);
  });

  it('does not expire a quiet alias when capacity is available', () => {
    const session = {
      cookie: {} as SessionData['cookie'],
      allowedGvuiLayoutIds: [LAYOUT],
      gvuiMailboxes: { quiet: entry(1) },
    } as SessionData;
    pruneGvuiMailboxes(session, now);
    expect(session.gvuiMailboxes.quiet).toBeDefined();
  });

  it('gives legacy aliases an observation window before reclaiming them', () => {
    const session = {
      cookie: {} as SessionData['cookie'],
      allowedGvuiLayoutIds: [LAYOUT],
      gvuiMailboxes: Object.fromEntries(
        Array.from({ length: 512 }, (_, i) => [`legacy-${i}`, entry()]),
      ),
    } as SessionData;
    pruneGvuiMailboxes(session, now);
    expect(Object.keys(session.gvuiMailboxes)).toHaveLength(512);
    expect(session.gvuiMailboxes['legacy-0'].lastUsedAt).toBe(now);
    session.gvuiMailboxes['legacy-0'].lastUsedAt =
      now + GVUI_MAILBOX_IDLE_MS - 1;
    pruneGvuiMailboxes(session, now + GVUI_MAILBOX_IDLE_MS);
    expect(Object.keys(session.gvuiMailboxes)).toEqual(['legacy-0']);
  });

  it('removes revoked-layout aliases without waiting for idle reclamation', () => {
    const session = {
      cookie: {} as SessionData['cookie'],
      allowedGvuiLayoutIds: [],
      gvuiMailboxes: { revoked: entry(now) },
    } as SessionData;
    pruneGvuiMailboxes(session, now);
    expect(session.gvuiMailboxes).toEqual({});
  });
});
