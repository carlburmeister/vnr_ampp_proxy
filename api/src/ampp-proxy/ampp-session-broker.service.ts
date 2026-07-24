import { Injectable } from '@nestjs/common';
import type { SessionData } from 'express-session';
import { CookieJar } from 'tough-cookie';

import {
  amppProxySessionDebugLog,
  amppProxySessionDebugWarn,
} from './ampp-proxy-session-debug';
import { AmppUtilityLoginService } from './ampp-utility-login.service';

@Injectable()
export class AmppSessionBrokerService {
  private readonly loginPromises = new Map<
    string,
    Promise<ReturnType<CookieJar['toJSON']>>
  >();

  constructor(
    private readonly utilityLogin: AmppUtilityLoginService,
  ) {}

  async getCookieJar(
    frontendSessionId: string,
    session: SessionData,
    returnPath: string,
  ): Promise<CookieJar> {
    if (session.amppCookieJar) {
      amppProxySessionDebugLog(
        `Restoring AMPP cookie jar cookies=${session.amppCookieJar.cookies?.length ?? 0}`,
        frontendSessionId,
      );
      return CookieJar.fromJSON(session.amppCookieJar);
    }

    amppProxySessionDebugLog(
      'No AMPP cookie jar found; creating an AMPP utility session',
      frontendSessionId,
    );

    const serializedCookieJar = await this.getOrCreateLoginPromise(
      frontendSessionId,
      returnPath,
    );

    session.amppCookieJar = serializedCookieJar;
    amppProxySessionDebugLog(
      `Stored new AMPP cookie jar cookies=${serializedCookieJar.cookies?.length ?? 0}`,
      frontendSessionId,
    );
    return CookieJar.fromJSON(serializedCookieJar);
  }

  async recreateCookieJar(
    frontendSessionId: string,
    session: SessionData,
    returnPath: string,
  ): Promise<CookieJar> {
    amppProxySessionDebugLog(
      'Discarding AMPP cookie jar and re-authenticating',
      frontendSessionId,
    );
    delete session.amppCookieJar;
    return this.getCookieJar(frontendSessionId, session, returnPath);
  }

  saveCookieJar(
    frontendSessionId: string,
    session: SessionData,
    cookieJar: CookieJar,
  ): void {
    session.amppCookieJar = cookieJar.toJSON();
    amppProxySessionDebugLog(
      `Saved AMPP cookie jar cookies=${session.amppCookieJar.cookies?.length ?? 0}`,
      frontendSessionId,
    );
  }

  private getOrCreateLoginPromise(
    frontendSessionId: string,
    returnPath: string,
  ): Promise<ReturnType<CookieJar['toJSON']>> {
    const existingPromise = this.loginPromises.get(frontendSessionId);

    if (existingPromise) {
      amppProxySessionDebugLog(
        'Reusing in-progress AMPP utility login',
        frontendSessionId,
      );
      return existingPromise;
    }

    amppProxySessionDebugLog(
      'Starting AMPP utility login',
      frontendSessionId,
    );

    const loginPromise = this.utilityLogin
      .login(returnPath)
      .then((cookieJar) => {
        amppProxySessionDebugLog(
          'AMPP utility login completed',
          frontendSessionId,
        );
        return cookieJar.toJSON();
      })
      .catch((error) => {
        amppProxySessionDebugWarn(
          `AMPP utility login failed: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
          frontendSessionId,
        );
        throw error;
      })
      .finally(() => {
        this.loginPromises.delete(frontendSessionId);
      });

    this.loginPromises.set(frontendSessionId, loginPromise);
    return loginPromise;
  }
}
