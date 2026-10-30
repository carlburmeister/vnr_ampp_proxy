import type { SessionData } from 'express-session';
import { AmppSessionBrokerService } from '../ampp-session-broker.service';
import { storeAmppAccessToken } from '../ampp-access-tokens';
import { amppToken } from './helpers/ampp-token';

describe('AMPP authentication reset', () => {
  it('clears every token before recreating the utility cookie jar', async () => {
    const session = {
      amppAccessToken: amppToken('legacy'),
      amppUserId: 'old-user',
      amppCookieJar: {},
    } as SessionData;
    storeAmppAccessToken(session, amppToken('wrapper'));
    storeAmppAccessToken(session, amppToken('gvui', ['platform']));
    const login = jest.fn(() => {
      expect(session.amppAccessTokens).toBeUndefined();
      expect(session.amppAccessToken).toBeUndefined();
      expect(session.amppCookieJar).toBeUndefined();
      expect(session.amppUserId).toBeUndefined();
      return Promise.resolve({ toJSON: () => ({ cookies: [] }) });
    });
    const broker = new AmppSessionBrokerService({ login } as never);
    await broker.recreateCookieJar('sid', session, '/app/wrapper/refresh.html');
    expect(session.amppTokenGeneration).toEqual(expect.any(String));
    expect(login).toHaveBeenCalledTimes(1);
  });
});
