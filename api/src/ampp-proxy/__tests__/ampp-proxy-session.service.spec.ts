import type { Request } from 'express';
import { AmppProxySessionService } from '../ampp-proxy-session.service';

describe('AMPP proxy session persistence', () => {
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
      allowedGvuiLayouts: [], allowedGvuiLayoutIds: [], gvuiPhase2Enabled: true,
    });
    Object.assign(req.session, {
      authorizationFingerprint: 'granted', authorizationCheckedAt: 100,
      allowedGvuiLayouts: [{ id: 'old-layout', name: 'Old', associatedWorkloadId: null }],
      allowedGvuiLayoutIds: ['old-layout'], gvuiPhase2Enabled: false,
    });
    await service.saveIfChanged(req as unknown as Request, snapshot);
    expect(req.session).toMatchObject({
      allowedGvuiLayouts: [], allowedGvuiLayoutIds: [], gvuiPhase2Enabled: true,
      authorizationFingerprint: 'revoked', authorizationCheckedAt: 200,
    });
    expect(req.session.save).not.toHaveBeenCalled();
  });
});
