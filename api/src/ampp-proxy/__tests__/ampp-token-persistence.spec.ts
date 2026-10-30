import type { Request } from 'express';
import type { SessionData } from 'express-session';
import { AmppProxySessionService } from '../ampp-proxy-session.service';
import {
  clearAmppAccessTokens,
  storeAmppAccessToken,
} from '../ampp-access-tokens';
import { amppToken } from './helpers/ampp-token';

describe('Concurrent AMPP token persistence', () => {
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  function setup(initial: Partial<SessionData> = {}) {
    let stored = clone(initial);
    const service = new AmppProxySessionService();
    function start() {
      const req = {
        sessionID: 'sid',
        session: clone(stored),
        sessionStore: {
          get: (
            _sid: string,
            callback: (
              error: Error | null,
              value: Partial<SessionData>,
            ) => void,
          ) => callback(null, clone(stored)),
        },
      } as unknown as Request;
      Object.assign(req.session, {
        touch: () => {},
        save: (done: () => void) => {
          stored = clone(req.session);
          done();
        },
      });
      const snapshot = service.snapshot(req.session);
      return { req, save: () => service.saveIfChanged(req, snapshot) };
    }
    return { start, stored: () => stored };
  }

  it('merges independent clients from concurrent callback responses', async () => {
    const state = setup();
    const a = state.start(),
      b = state.start();
    storeAmppAccessToken(a.req.session, amppToken('wrapper'));
    storeAmppAccessToken(b.req.session, amppToken('gvui', ['platform']));
    await Promise.all([a.save(), b.save()]);
    expect(Object.keys(state.stored().amppAccessTokens).sort()).toEqual([
      'gvui',
      'wrapper',
    ]);
  });

  it.each([true, false])(
    'keeps the newer token when newer response saves first: %s',
    async (newerFirst) => {
      const state = setup();
      const older = state.start(),
        newer = state.start();
      const now = Math.floor(Date.now() / 1000);
      const token = amppToken('wrapper', ['platform', 'cluster'], { iat: now });
      storeAmppAccessToken(
        older.req.session,
        amppToken('wrapper', ['platform', 'cluster'], { iat: now - 100 }),
      );
      storeAmppAccessToken(newer.req.session, token);
      for (const request of newerFirst ? [newer, older] : [older, newer])
        await request.save();
      expect(state.stored().amppAccessTokens.wrapper.token).toBe(token);
    },
  );

  it('does not let a delayed 401 removal delete a renewed token', async () => {
    const initial = {} as SessionData;
    storeAmppAccessToken(initial, amppToken('wrapper'));
    const state = setup(initial),
      rejected = state.start(),
      renewed = state.start();
    delete rejected.req.session.amppAccessTokens.wrapper;
    const replacement = amppToken('wrapper', ['platform', 'cluster'], {
      iat: Math.floor(Date.now() / 1000) + 1,
    });
    storeAmppAccessToken(renewed.req.session, replacement);
    await renewed.save();
    await rejected.save();
    expect(state.stored().amppAccessTokens.wrapper.token).toBe(replacement);
  });

  it('removes only a rejected client while preserving a concurrent independent renewal', async () => {
    const initial = {} as SessionData;
    storeAmppAccessToken(initial, amppToken('wrapper'));
    const state = setup(initial),
      rejected = state.start(),
      renewed = state.start();
    delete rejected.req.session.amppAccessTokens.wrapper;
    storeAmppAccessToken(renewed.req.session, amppToken('gvui', ['platform']));
    await renewed.save();
    await rejected.save();
    expect(Object.keys(state.stored().amppAccessTokens)).toEqual(['gvui']);
  });

  it.each([true, false])(
    'clears pre-reset tokens when the reset saves first: %s',
    async (resetFirst) => {
      const initial = {} as SessionData;
      storeAmppAccessToken(initial, amppToken('wrapper'));
      const state = setup(initial),
        stale = state.start(),
        reset = state.start();
      storeAmppAccessToken(stale.req.session, amppToken('late-client'));
      clearAmppAccessTokens(reset.req.session);
      storeAmppAccessToken(reset.req.session, amppToken('new-client'));
      for (const request of resetFirst ? [reset, stale] : [stale, reset])
        await request.save();
      expect(Object.keys(state.stored().amppAccessTokens)).toEqual([
        'new-client',
      ]);
      expect(state.stored().amppTokenGeneration).toBe(
        reset.req.session.amppTokenGeneration,
      );
    },
  );

  it('preserves a reset even when the delayed request changes only another cache', async () => {
    const initial = {} as SessionData;
    storeAmppAccessToken(initial, amppToken('wrapper'));
    const state = setup(initial),
      stale = state.start(),
      reset = state.start();
    stale.req.session.amppUserId = 'upstream-user';
    clearAmppAccessTokens(reset.req.session);
    await reset.save();
    await stale.save();
    expect(state.stored().amppAccessTokens).toBeUndefined();
  });

  it('copies the latest credentials after a concurrent client authorization change', async () => {
    const state = setup({
      authorizationFingerprint: 'old',
      amppAccessToken: amppToken('legacy'),
    });
    const stale = state.start(),
      changed = state.start();
    stale.req.session.amppUserId = 'old-client-user';
    storeAmppAccessToken(stale.req.session, amppToken('old-client'));
    changed.req.session.authorizationFingerprint = 'new';
    // This change represents authorization already saved by the session guard.
    changed.req.session.save(() => {});
    await stale.save();
    expect(stale.req.session.amppAccessTokens).toBeUndefined();
    expect(stale.req.session.amppAccessToken).toBe(
      state.stored().amppAccessToken,
    );
    expect(state.stored().authorizationFingerprint).toBe('new');
  });

  it('does not restore an old cookie jar while preserving a newer authentication reset', async () => {
    const state = setup();
    const stale = state.start(),
      reset = state.start();
    Object.assign(stale.req.session, {
      amppCookieJar: { cookies: [{ key: 'old' }] },
      amppUserId: 'old-user',
    });
    clearAmppAccessTokens(reset.req.session);
    Object.assign(reset.req.session, {
      amppCookieJar: { cookies: [{ key: 'new' }] },
    });
    await reset.save();
    await stale.save();
    expect(state.stored().amppCookieJar).toEqual({ cookies: [{ key: 'new' }] });
    expect(state.stored().amppUserId).toBeUndefined();
  });
});
