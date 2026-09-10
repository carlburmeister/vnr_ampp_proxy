import { BadGatewayException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Method } from 'axios';
import type { SessionData } from 'express-session';
import type { IncomingHttpHeaders } from 'node:http';
import type { CookieJar } from 'tough-cookie';

import { AmppBearerTokenService } from './ampp-bearer-token.service';
import { AmppBrowserSecurityService } from './ampp-browser-security.service';
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
    private readonly bearerToken: AmppBearerTokenService,
    private readonly browserSecurity: AmppBrowserSecurityService,
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

    this.captureOidcAccessToken(
      session,
      requestPath,
      response,
      frontendSessionId,
    );

    amppProxySessionDebugLog(
      `AMPP session request completed status=${response.status} path=${requestPath}`,
      frontendSessionId,
    );

    return this.browserSecurity.secureUiResponse(
      this.responseRewriter.rewrite(
        workloadId,
        publicOrigin,
        response,
      ),
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
    const sessionToken = this.bearerToken.getSessionToken(session);
    let token = sessionToken ?? (await this.bearerToken.getToken());
    let response = await this.requestApiResource(
      cookieJar,
      method,
      upstreamPath,
      browserHeaders,
      body,
      workloadId,
      publicOrigin,
      token,
    );

    if (response.status === 401 && sessionToken) {
      this.bearerToken.clearSessionToken(session);
    } else if (response.status === 401) {
      this.bearerToken.invalidate();
      token = await this.bearerToken.getToken();
      response = await this.requestApiResource(
        cookieJar,
        method,
        upstreamPath,
        browserHeaders,
        body,
        workloadId,
        publicOrigin,
        token,
      );
    }

    response = this.filterMatrixApiResponse(
      session,
      upstreamPath,
      response,
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

  private filterMatrixApiResponse(
    session: SessionData,
    upstreamPath: string,
    response: AmppCookieHttpResponse,
  ): AmppCookieHttpResponse {
    const target = new URL(upstreamPath, this.platformUrl);
    const pathname = target.pathname.replace(/\/+$/, '').toLowerCase();
    const responseKeys: Record<string, string> = {
      '/cluster/matrix/api/v1/producers': 'producers',
      '/cluster/matrix/api/v1/consumers': 'consumers',
      '/cluster/matrix/api/v1/routing/sources': 'sources',
      '/cluster/matrix/api/v1/routing/destinations': 'destinations',
    };
    const responseKey = responseKeys[pathname];

    if (!responseKey || response.status < 200 || response.status >= 300) {
      return response;
    }

    const fabricId = target.searchParams.get('fabricId')?.toLowerCase();

    if (!fabricId) {
      throw new BadGatewayException('AMPP Matrix response is missing fabricId');
    }

    let parsed: Record<string, unknown>;

    try {
      parsed = JSON.parse(response.body.toString('utf8')) as Record<
        string,
        unknown
      >;
    } catch {
      throw new BadGatewayException('AMPP Matrix response is not valid JSON');
    }

    const items = parsed[responseKey];

    if (!Array.isArray(items)) {
      throw new BadGatewayException(
        `AMPP Matrix response is missing ${responseKey}`,
      );
    }

    const allowedWorkloadIds = new Set(
      (
        session.amppAllowedWorkloadIds ??
        (session.allowedWorkloads ?? []).flatMap((workload) => [
          workload.id,
          ...(workload.child_workloads ?? []).map(
            (childWorkload) => childWorkload.id,
          ),
        ])
      )
        .filter(Boolean)
        .map((id) => id.toLowerCase()),
    );
    const matrixAccess = (session.amppMatrixAccess ??= {});
    const fabricAccess = (matrixAccess[fabricId] ??= {});
    let filteredItems: unknown[];

    if (responseKey === 'producers') {
      filteredItems = items.flatMap((item) => {
        const wrapper = this.asObject(item);
        const producer = this.asObject(wrapper?.producer);
        const workloadId = producer?.workloadId;

        if (
          typeof workloadId !== 'string' ||
          !allowedWorkloadIds.has(workloadId.toLowerCase())
        ) {
          return [];
        }

        const routedConsumers = Array.isArray(producer.routedConsumers)
          ? producer.routedConsumers.filter((consumer) => {
              const routedConsumer = this.asObject(consumer);
              return (
                typeof routedConsumer?.workloadId === 'string' &&
                allowedWorkloadIds.has(
                  routedConsumer.workloadId.toLowerCase(),
                )
              );
            })
          : [];
        const filteredProducer = {
          ...producer,
          ...(Array.isArray(producer.routedConsumers)
            ? { routedConsumers }
            : {}),
          ...(producer.routedConsumerIds !== undefined
            ? {
                routedConsumerIds: routedConsumers.flatMap((consumer) => {
                  const id = this.asObject(consumer)?.id;
                  return typeof id === 'string' ? [id] : [];
                }),
              }
            : {}),
        };

        return [{ ...wrapper, producer: filteredProducer }];
      });
      fabricAccess.producerIds = filteredItems.flatMap((item) => {
        const id = this.asObject(this.asObject(item)?.producer)?.id;
        return typeof id === 'string' ? [id] : [];
      });
    } else if (responseKey === 'consumers') {
      filteredItems = items.filter((item) => {
        const workloadId = this.asObject(
          this.asObject(item)?.consumer,
        )?.workloadId;
        return (
          typeof workloadId === 'string' &&
          allowedWorkloadIds.has(workloadId.toLowerCase())
        );
      });
      fabricAccess.consumerIds = filteredItems.flatMap((item) => {
        const id = this.asObject(this.asObject(item)?.consumer)?.id;
        return typeof id === 'string' ? [id] : [];
      });
    } else if (responseKey === 'sources') {
      const producerIds = new Set(fabricAccess.producerIds ?? []);
      const consumerIds = new Set(fabricAccess.consumerIds ?? []);

      filteredItems = items.flatMap((item) => {
        const source = this.asObject(item);

        if (!source || !producerIds.has(String(source.id))) {
          return [];
        }

        return [
          {
            ...source,
            ...(Array.isArray(source.destinationIds)
              ? {
                  destinationIds: source.destinationIds.filter(
                    (id) => typeof id === 'string' && consumerIds.has(id),
                  ),
                }
              : {}),
          },
        ];
      });
    } else {
      const producerIds = new Set(fabricAccess.producerIds ?? []);
      const consumerIds = new Set(fabricAccess.consumerIds ?? []);

      filteredItems = items.flatMap((item) => {
        const destination = this.asObject(item);

        if (!destination || !consumerIds.has(String(destination.id))) {
          return [];
        }

        return [
          {
            ...destination,
            ...(typeof destination.sourceId === 'string' &&
            !producerIds.has(destination.sourceId)
              ? { sourceId: null }
              : {}),
          },
        ];
      });
    }

    return {
      ...response,
      headers: {
        ...response.headers,
        'content-length': undefined,
        etag: undefined,
        'last-modified': undefined,
      },
      body: Buffer.from(
        JSON.stringify({
          ...parsed,
          [responseKey]: filteredItems,
        }),
      ),
    };
  }

  private asObject(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  }

  private captureOidcAccessToken(
    session: SessionData,
    requestPath: string,
    response: AmppCookieHttpResponse,
    frontendSessionId: string,
  ): void {
    const requestUrl = new URL(requestPath, this.platformUrl);

    if (
      requestUrl.pathname.toLowerCase() !== '/identity/connect/authorize' ||
      response.status < 300 ||
      response.status >= 400
    ) {
      return;
    }

    const location = this.firstHeader(response.headers.location);

    if (!location) {
      return;
    }

    try {
      const redirectUrl = new URL(location, this.platformUrl);

      if (redirectUrl.origin !== this.platformUrl.origin) {
        return;
      }

      const accessToken = new URLSearchParams(
        redirectUrl.hash.replace(/^#/, ''),
      ).get('access_token');

      if (!accessToken) {
        return;
      }

      session.amppAccessToken = accessToken;
      amppProxySessionDebugLog(
        'Captured AMPP utility-user bearer token server-side',
        frontendSessionId,
      );
    } catch {
      // Leave malformed AMPP redirect responses unchanged.
    }
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
    token: string,
  ): Promise<AmppCookieHttpResponse> {
    return this.http.request(cookieJar, upstreamPath, {
      method: method as Method,
      headers: this.createApiUpstreamHeaders(
        browserHeaders,
        workloadId,
        publicOrigin,
        upstreamPath,
        token,
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
    token: string,
  ): Record<string, string> {
    const headers = this.createUpstreamHeaders(
      browserHeaders,
      workloadId,
      publicOrigin,
      upstreamPath,
    );

    headers.Authorization = `Bearer ${token}`;

    for (const [browserName, upstreamName] of [
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
