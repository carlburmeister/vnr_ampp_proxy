import { BadGatewayException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Method } from 'axios';
import type { SessionData } from 'express-session';
import type { IncomingHttpHeaders } from 'node:http';
import type { CookieJar } from 'tough-cookie';

import {
  AmppCookieHttpService,
  type AmppCookieHttpResponse,
} from './ampp-cookie-http.service';
import {
  amppProxySessionDebugLog,
  amppProxySessionDebugWarn,
} from './ampp-proxy-session-debug';
import {
  AmppResponseRewriterService,
  type AmppBrowserResponse,
} from './ampp-response-rewriter.service';
import { AmppSessionBrokerService } from './ampp-session-broker.service';
import { AmppUtilityLoginService } from './ampp-utility-login.service';

@Injectable()
export class AmppProxyService {
  private readonly platformUrl: URL;

  constructor(
    private readonly config: ConfigService,
    private readonly http: AmppCookieHttpService,
    private readonly responseRewriter: AmppResponseRewriterService,
    private readonly sessionBroker: AmppSessionBrokerService,
    private readonly utilityLogin: AmppUtilityLoginService,
  ) {
    this.platformUrl = new URL(
      this.config.getOrThrow<string>('PLATFORM_URL'),
    );
  }

  async getUiResource(
    frontendSessionId: string,
    session: SessionData,
    workloadId: string,
    upstreamPath: string,
    browserHeaders: IncomingHttpHeaders,
    publicOrigin: string,
  ): Promise<AmppBrowserResponse> {
    const requestPath = this.normalizeOidcAuthorizePath(
      workloadId,
      upstreamPath,
    );
    let cookieJar = await this.sessionBroker.getCookieJar(
      frontendSessionId,
      session,
      requestPath,
    );
    let response = await this.requestUiResource(
      cookieJar,
      requestPath,
      browserHeaders,
      workloadId,
      publicOrigin,
    );

    if (this.utilityLogin.isLoginResponse(response)) {
      amppProxySessionDebugLog(
        `AMPP rejected the stored session; retrying login path=${requestPath}`,
        frontendSessionId,
      );
      cookieJar = await this.sessionBroker.recreateCookieJar(
        frontendSessionId,
        session,
        requestPath,
      );
      response = await this.requestUiResource(
        cookieJar,
        requestPath,
        browserHeaders,
        workloadId,
        publicOrigin,
      );
    }

    this.sessionBroker.saveCookieJar(
      frontendSessionId,
      session,
      cookieJar,
    );

    if (this.utilityLogin.isLoginResponse(response)) {
      amppProxySessionDebugWarn(
        `AMPP session remained unauthenticated after retry path=${requestPath}`,
        frontendSessionId,
      );
      throw new BadGatewayException('AMPP utility session is not authenticated');
    }

    amppProxySessionDebugLog(
      `AMPP session request completed status=${response.status} path=${requestPath}`,
      frontendSessionId,
    );

    return this.responseRewriter.rewrite(
      workloadId,
      publicOrigin,
      response,
    );
  }

  async proxyApiRequest(
    frontendSessionId: string,
    session: SessionData,
    workloadId: string,
    method: string,
    upstreamPath: string,
    browserHeaders: IncomingHttpHeaders,
    body: Buffer | undefined,
    publicOrigin: string,
  ): Promise<AmppBrowserResponse> {
    const cookieJar = await this.sessionBroker.getCookieJar(
      frontendSessionId,
      session,
      upstreamPath,
    );
    const response = await this.requestApiResource(
      cookieJar,
      method,
      upstreamPath,
      browserHeaders,
      body,
      workloadId,
      publicOrigin,
    );

    this.sessionBroker.saveCookieJar(
      frontendSessionId,
      session,
      cookieJar,
    );

    amppProxySessionDebugLog(
      `AMPP API request completed status=${response.status} method=${method} path=${upstreamPath}`,
      frontendSessionId,
    );

    return this.responseRewriter.rewriteApi(
      workloadId,
      publicOrigin,
      response,
    );
  }

  private normalizeOidcAuthorizePath(
    workloadId: string,
    upstreamPath: string,
  ): string {
    const requestUrl = new URL(upstreamPath, this.platformUrl);

    if (requestUrl.pathname.toLowerCase() !== '/identity/connect/authorize') {
      return upstreamPath;
    }

    const proxyPrefix =
      `/api/ampp-proxy/ui/${encodeURIComponent(workloadId)}`;
    const removeProxyPrefix = (value: string): string =>
      value.split(proxyPrefix).join('');
    const redirectUri = requestUrl.searchParams.get('redirect_uri');

    if (redirectUri) {
      try {
        const callbackUrl = new URL(redirectUri, this.platformUrl);
        const callbackPath = removeProxyPrefix(callbackUrl.pathname) || '/';
        const normalizedCallback = new URL(
          `${callbackPath}${callbackUrl.search}${callbackUrl.hash}`,
          this.platformUrl,
        );

        requestUrl.searchParams.set(
          'redirect_uri',
          normalizedCallback.toString(),
        );
      } catch {
        // Leave malformed values unchanged so AMPP can reject the request.
      }
    }

    const state = requestUrl.searchParams.get('state');

    if (state) {
      try {
        const parsedState = JSON.parse(state) as { to?: unknown };

        if (typeof parsedState.to === 'string') {
          parsedState.to = removeProxyPrefix(parsedState.to);
          requestUrl.searchParams.set('state', JSON.stringify(parsedState));
        }
      } catch {
        // Preserve non-JSON state values unchanged.
      }
    }

    return `${requestUrl.pathname}${requestUrl.search}${requestUrl.hash}`;
  }

  private requestUiResource(
    cookieJar: CookieJar,
    upstreamPath: string,
    browserHeaders: IncomingHttpHeaders,
    workloadId: string,
    publicOrigin: string,
  ): Promise<AmppCookieHttpResponse> {
    return this.http.request(cookieJar, upstreamPath, {
      headers: this.createUpstreamHeaders(
        browserHeaders,
        workloadId,
        publicOrigin,
        upstreamPath,
      ),
    });
  }

  private requestApiResource(
    cookieJar: CookieJar,
    method: string,
    upstreamPath: string,
    browserHeaders: IncomingHttpHeaders,
    body: Buffer | undefined,
    workloadId: string,
    publicOrigin: string,
  ): Promise<AmppCookieHttpResponse> {
    return this.http.request(cookieJar, upstreamPath, {
      method: method as Method,
      headers: this.createApiUpstreamHeaders(
        browserHeaders,
        workloadId,
        publicOrigin,
        upstreamPath,
      ),
      data: body,
    });
  }

  private createUpstreamHeaders(
    browserHeaders: IncomingHttpHeaders,
    workloadId: string,
    publicOrigin: string,
    upstreamPath: string,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: this.firstHeader(browserHeaders.accept) ?? '*/*',
      Origin: this.platformUrl.origin,
      Referer: this.createUpstreamReferer(
        browserHeaders.referer,
        workloadId,
        publicOrigin,
        upstreamPath,
      ),
    };

    for (const [browserName, upstreamName] of [
      ['accept-language', 'Accept-Language'],
      ['if-modified-since', 'If-Modified-Since'],
      ['if-none-match', 'If-None-Match'],
      ['range', 'Range'],
      ['user-agent', 'User-Agent'],
    ] as const) {
      const value = this.firstHeader(browserHeaders[browserName]);

      if (value) {
        headers[upstreamName] = value;
      }
    }

    return headers;
  }

  private createApiUpstreamHeaders(
    browserHeaders: IncomingHttpHeaders,
    workloadId: string,
    publicOrigin: string,
    upstreamPath: string,
  ): Record<string, string> {
    const headers = this.createUpstreamHeaders(
      browserHeaders,
      workloadId,
      publicOrigin,
      upstreamPath,
    );

    for (const [browserName, upstreamName] of [
      ['authorization', 'Authorization'],
      ['content-type', 'Content-Type'],
      ['x-correlation-id', 'X-Correlation-Id'],
      ['x-requested-with', 'X-Requested-With'],
      ['x-service-instance', 'X-Service-Instance'],
    ] as const) {
      const value = this.firstHeader(browserHeaders[browserName]);

      if (value) {
        headers[upstreamName] = value;
      }
    }

    return headers;
  }

  private createUpstreamReferer(
    referer: string | undefined,
    workloadId: string,
    publicOrigin: string,
    upstreamPath: string,
  ): string {
    if (referer) {
      try {
        const refererUrl = new URL(referer);
        const proxyPrefixes = [
          `/api/ampp-proxy/ui/${encodeURIComponent(workloadId)}`,
          `/api/ampp-proxy/api/${encodeURIComponent(workloadId)}`,
        ];
        const matchingPrefix = proxyPrefixes.find((prefix) =>
          refererUrl.pathname.startsWith(prefix),
        );

        if (refererUrl.origin === publicOrigin && matchingPrefix) {
          return new URL(
            `${refererUrl.pathname.slice(matchingPrefix.length) || '/'}${refererUrl.search}`,
            this.platformUrl,
          ).toString();
        }
      } catch {
        // Fall through to the current upstream path.
      }
    }

    return new URL(upstreamPath, this.platformUrl).toString();
  }

  private firstHeader(
    value: string | string[] | undefined,
  ): string | undefined {
    return Array.isArray(value) ? value[0] : value;
  }
}
