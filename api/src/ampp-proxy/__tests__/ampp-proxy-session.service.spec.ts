import type { Request } from 'express';
import type { SessionData } from 'express-session';
import { AmppProxySessionService } from '../ampp-proxy-session.service';

describe('AMPP proxy session persistence', () => {
  it('merges panel catalogues from independent workload tabs without restoring a newer removal', async () => {
    const { req, service } = setup({
      amppPanelIdsByWorkload: { first: ['panel-a'], second: ['panel-b'] },
    });
    Object.assign(req.session, {
      amppPanelIdsByWorkload: { first: ['panel-a'] },
    });
    const snapshot = service.snapshot(req.session as never);
    Object.assign(req.session, {
      amppPanelIdsByWorkload: { first: ['panel-c'] },
    });
    await service.saveIfChanged(req as unknown as Request, snapshot);
    expect(req.session).toMatchObject({
      amppPanelIdsByWorkload: { first: ['panel-c'], second: ['panel-b'] },
    });

    const removed = setup({ amppPanelIdsByWorkload: {} });
    Object.assign(removed.req.session, {
      amppPanelIdsByWorkload: { first: ['panel-a'] },
    });
    const before = removed.service.snapshot(removed.req.session as never);
    Object.assign(removed.req.session, {
      amppPanelIdsByWorkload: { first: ['panel-c'] },
    });
    await removed.service.saveIfChanged(
      removed.req as unknown as Request,
      before,
    );
    expect(removed.req.session).toMatchObject({ amppPanelIdsByWorkload: {} });
  });

  it('discards panel IDs learned before a concurrent permission revocation', async () => {
    const { req, service, snapshot } = setup({
      authorizationFingerprint: 'revoked',
      amppPanelIdsByWorkload: {},
    });
    Object.assign(req.session, {
      authorizationFingerprint: 'granted',
      amppPanelIdsByWorkload: { first: ['panel-a'] },
    });
    await service.saveIfChanged(req as unknown as Request, snapshot);
    expect(req.session).toMatchObject({ amppPanelIdsByWorkload: {} });
    expect(req.session.save).not.toHaveBeenCalled();
  });

  function setup(stored: unknown) {
    const req = {
      sessionID: 'sid',
      session: {
        amppUserId: 'before',
        touch: jest.fn(),
        save: jest.fn((callback: (error?: Error) => void) => {
          callback();
        }),
      },
      sessionStore: {
        get: jest.fn(
          (
            _sid: string,
            callback: (error: Error | null, value: unknown) => void,
          ) => {
            callback(null, stored);
          },
        ),
      },
    };
    const service = new AmppProxySessionService();
    const snapshot = service.snapshot(req.session as never);
    req.session.amppUserId = 'after';
    return { req, service, snapshot };
  }

  it('does not save an upstream response after the stored session disappears', async () => {
    const { req, service, snapshot } = setup(null);
    await service.saveIfChanged(req as unknown as Request, snapshot);
    expect(req.session.save).not.toHaveBeenCalled();
  });

  it('still persists upstream cache updates for a live session', async () => {
    const { req, service, snapshot } = setup({ amppUserId: 'before' });
    await service.saveIfChanged(req as unknown as Request, snapshot);
    expect(req.session.touch).toHaveBeenCalled();
    expect(req.session.save).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite permissions refreshed while the request was proxied', async () => {
    const { req, service, snapshot } = setup({
      authorizationFingerprint: 'new-permissions',
      amppUserId: 'before',
    });
    await service.saveIfChanged(req as unknown as Request, snapshot);
    expect(req.session.save).not.toHaveBeenCalled();
  });

  it('copies newer GVUI authorization without restoring revoked access', async () => {
    const { req, service, snapshot } = setup({
      authorizationFingerprint: 'revoked', authorizationCheckedAt: 200,
      allowedGvuiLayouts: [], allowedGvuiLayoutIds: [],
    });
    Object.assign(req.session, {
      authorizationFingerprint: 'granted', authorizationCheckedAt: 100,
      allowedGvuiLayouts: [{ id: 'old-layout', name: 'Old', associatedWorkloadId: null }],
      allowedGvuiLayoutIds: ['old-layout'],
      gvuiMailboxes: { stale: { contextId: 'gvui-old-layout', upstreamId: 'upstream', createdAt: 100 } },
    });
    await service.saveIfChanged(req as unknown as Request, snapshot);
    expect(req.session).toMatchObject({
      allowedGvuiLayouts: [], allowedGvuiLayoutIds: [],
      authorizationFingerprint: 'revoked', authorizationCheckedAt: 200,
    });
    expect(req.session.save).not.toHaveBeenCalled();
    expect((req.session as any).gvuiMailboxes).toBeUndefined();
  });

  it('merges mailbox ownership created concurrently by independent layout tabs', async () => {
    const second = { contextId: 'gvui-second', upstreamId: 'second', createdAt: 200 };
    const first = { contextId: 'gvui-first', upstreamId: 'first', createdAt: 100 };
    const { req, service, snapshot } = setup({ gvuiMailboxes: { second } });
    Object.assign(req.session, { gvuiMailboxes: { first } });
    await service.saveIfChanged(req as unknown as Request, snapshot);
    expect((req.session as any).gvuiMailboxes).toEqual({ first, second });
    expect(req.session.save).toHaveBeenCalledTimes(1);
  });

  it('persists a learned recorder even when no other session field changes', async () => {
    const { req, service } = setup({ amppUserId: 'before' });
    req.session.amppUserId = 'before';
    const snapshot = service.snapshot(req.session as never);
    Object.assign(req.session, {
      amppRecorderIdsByWorkload: { first: 'recorder-one' },
    });
    await service.saveIfChanged(req as unknown as Request, snapshot);
    expect(req.session.save).toHaveBeenCalledTimes(1);
  });

  it('merges recorder IDs loaded by independent workload tabs', async () => {
    const { req, service, snapshot } = setup({
      amppRecorderIdsByWorkload: { second: 'recorder-two' },
    });
    Object.assign(req.session, {
      amppRecorderIdsByWorkload: { first: 'recorder-one' },
    });
    await service.saveIfChanged(req as unknown as Request, snapshot);
    expect(req.session).toMatchObject({
      amppRecorderIdsByWorkload: {
        first: 'recorder-one',
        second: 'recorder-two',
      },
    });
  });

  it.each(['old-recorder', 'delayed-recorder'])(
    'does not overwrite a concurrently replaced recorder with %s',
    async (after) => {
      const { req, service } = setup({
        amppRecorderIdsByWorkload: { first: 'new-recorder' },
      });
      Object.assign(req.session, {
        amppRecorderIdsByWorkload: { first: 'old-recorder' },
      });
      const snapshot = service.snapshot(req.session as never);
      Object.assign(req.session, {
        amppRecorderIdsByWorkload: { first: after },
      });
      req.session.amppUserId = 'changed-after-snapshot';
      await service.saveIfChanged(req as unknown as Request, snapshot);
      expect(req.session).toMatchObject({
        amppRecorderIdsByWorkload: { first: 'new-recorder' },
      });
    },
  );

  it('replaces an uncontested recorder association without retaining its old ID', async () => {
    const { req, service } = setup({
      amppRecorderIdsByWorkload: { first: 'old-recorder' },
    });
    Object.assign(req.session, {
      amppRecorderIdsByWorkload: { first: 'old-recorder' },
    });
    const snapshot = service.snapshot(req.session as never);
    Object.assign(req.session, {
      amppRecorderIdsByWorkload: { first: 'new-recorder' },
    });
    await service.saveIfChanged(req as unknown as Request, snapshot);
    expect(req.session).toMatchObject({
      amppRecorderIdsByWorkload: { first: 'new-recorder' },
    });
  });

  it('does not restore a recorder association removed by another request', async () => {
    const { req, service } = setup({ amppRecorderIdsByWorkload: {} });
    Object.assign(req.session, {
      amppRecorderIdsByWorkload: { first: 'old-recorder' },
    });
    const snapshot = service.snapshot(req.session as never);
    Object.assign(req.session, {
      amppRecorderIdsByWorkload: { first: 'delayed-recorder' },
    });
    await service.saveIfChanged(req as unknown as Request, snapshot);
    expect(req.session).toMatchObject({ amppRecorderIdsByWorkload: {} });
    expect(req.session).not.toHaveProperty('amppRecorderIdsByWorkload.first');
  });

  it('drops a learned recorder if authorization changed while settings were loading', async () => {
    const { req, service, snapshot } = setup({
      authorizationFingerprint: 'revoked',
    });
    Object.assign(req.session, {
      amppRecorderIdsByWorkload: { first: 'recorder-one' },
    });
    await service.saveIfChanged(req as unknown as Request, snapshot);
    expect(req.session).toHaveProperty('amppRecorderIdsByWorkload', undefined);
    expect(req.session.save).not.toHaveBeenCalled();
  });

  it('does not recreate a logged-out session after learning a recorder', async () => {
    const { req, service, snapshot } = setup(null);
    Object.assign(req.session, {
      amppRecorderIdsByWorkload: { first: 'recorder-one' },
    });
    await service.saveIfChanged(req as unknown as Request, snapshot);
    expect(req.session.save).not.toHaveBeenCalled();
  });

  it('merges activity monotonically instead of restoring an older timestamp', async () => {
    const original = {
      contextId: 'gvui-layout',
      upstreamId: 'one',
      createdAt: 1,
      lastUsedAt: 100,
    };
    const { req, service } = setup({
      gvuiMailboxes: { alias: { ...original, lastUsedAt: 300 } },
    });
    Object.assign(req.session, { gvuiMailboxes: { alias: original } });
    const snapshot = service.snapshot(req.session as never);
    Object.assign(req.session, {
      gvuiMailboxes: { alias: { ...original, lastUsedAt: 200 } },
    });
    await service.saveIfChanged(req as unknown as Request, snapshot);
    expect(
      (req.session as unknown as SessionData).gvuiMailboxes.alias.lastUsedAt,
    ).toBe(300);
  });

  it('does not let stale idle cleanup remove a concurrently active alias', async () => {
    const original = {
      contextId: 'gvui-layout',
      upstreamId: 'one',
      createdAt: 1,
      lastUsedAt: 100,
    };
    const latest = { ...original, lastUsedAt: 300 };
    const { req, service } = setup({ gvuiMailboxes: { alias: latest } });
    Object.assign(req.session, { gvuiMailboxes: { alias: original } });
    const snapshot = service.snapshot(req.session as never);
    Object.assign(req.session, { gvuiMailboxes: {} });
    await service.saveIfChanged(req as unknown as Request, snapshot);
    expect((req.session as unknown as SessionData).gvuiMailboxes.alias).toEqual(
      latest,
    );
  });

  it.each([
    {},
    {
      alias: {
        contextId: 'gvui-layout',
        upstreamId: 'replacement',
        createdAt: 2,
        lastUsedAt: 300,
      },
    },
  ])(
    'does not resurrect removed ownership or replace a recreated alias with old activity',
    async (latest) => {
      const original = {
        contextId: 'gvui-layout',
        upstreamId: 'one',
        createdAt: 1,
        lastUsedAt: 100,
      };
      const { req, service } = setup({ gvuiMailboxes: latest });
      Object.assign(req.session, { gvuiMailboxes: { alias: original } });
      const snapshot = service.snapshot(req.session as never);
      Object.assign(req.session, {
        gvuiMailboxes: { alias: { ...original, lastUsedAt: 200 } },
      });
      await service.saveIfChanged(req as unknown as Request, snapshot);
      expect((req.session as unknown as SessionData).gvuiMailboxes).toEqual(
        latest,
      );
    },
  );

  it('enforces capacity after merging concurrent creations against the latest session', async () => {
    const layout = '11111111-1111-4111-8111-111111111111';
    const entry = {
      contextId: `gvui-${layout}`,
      upstreamId: 'one',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    };
    const common = Object.fromEntries(
      Array.from({ length: 511 }, (_, i) => [`shared-${i}`, entry]),
    );
    const { req, service } = setup({
      allowedGvuiLayoutIds: [layout],
      gvuiMailboxes: { ...common, anotherTab: entry },
    });
    Object.assign(req.session, {
      allowedGvuiLayoutIds: [layout],
      gvuiMailboxes: common,
    });
    const snapshot = service.snapshot(req.session as never);
    Object.assign(req.session, {
      gvuiMailboxes: { ...common, thisTab: entry },
    });
    await expect(
      service.saveIfChanged(req as unknown as Request, snapshot),
    ).rejects.toThrow('Too many open GV.UI mailboxes');
    expect(req.session.save).not.toHaveBeenCalled();
    const restored = (req.session as unknown as SessionData).gvuiMailboxes;
    expect(Object.keys(restored)).toHaveLength(512);
    expect(restored.anotherTab).toBeDefined();
    expect(restored.thisTab).toBeUndefined();
  });
});
