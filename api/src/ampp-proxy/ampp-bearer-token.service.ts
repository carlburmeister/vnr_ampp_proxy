import { BadGatewayException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SessionData } from 'express-session';

import { GVPlatform } from '../ampp/sdk/GVPlatform';
import { migrateAmppAccessToken } from './ampp-access-tokens';

const TOKEN_REFRESH_MARGIN_MS = 60_000;

@Injectable()
export class AmppBearerTokenService {
  private client?: GVPlatform;
  private loginPromise?: Promise<GVPlatform>;

  constructor(private readonly config: ConfigService) {}

  getSessionToken(
    session: SessionData,
    method = 'GET',
    upstreamPath = '/',
  ): string | undefined {
    migrateAmppAccessToken(session);
    const path = new URL(upstreamPath, 'http://ampp-proxy.local').pathname;
    // AMPP Store is a platform API despite its /cluster/store prefix.
    const scope =
      /^\/cluster\/(?:state|control|matrix|fabric|snapshot)\/api(?:\/|$)/i.test(
        path,
      )
        ? 'cluster'
        : 'platform';
    const readOnly = ['GET', 'HEAD'].includes(method.toUpperCase());
    const tokens = session.amppAccessTokens ?? {};
    for (const [clientId, entry] of Object.entries(tokens)) {
      if (entry.expiresAt <= Date.now() + TOKEN_REFRESH_MARGIN_MS)
        delete tokens[clientId];
    }
    return Object.values(tokens)
      .filter(
        (entry) =>
          entry.scopes.includes(scope) ||
          (readOnly && entry.scopes.includes(`${scope}.readonly`)),
      )
      .sort(
        (left, right) =>
          left.scopes.length - right.scopes.length ||
          right.issuedAt - left.issuedAt ||
          right.expiresAt - left.expiresAt,
      )[0]?.token;
  }

  clearSessionToken(session: SessionData, token: string): void {
    migrateAmppAccessToken(session);
    for (const [clientId, entry] of Object.entries(
      session.amppAccessTokens ?? {},
    )) {
      if (entry.token === token) delete session.amppAccessTokens[clientId];
    }
  }

  async getToken(): Promise<string> {
    const client = await this.getClient();
    const token = client.bearerToken;

    if (!token) {
      this.invalidate();
      throw new BadGatewayException('AMPP login returned no bearer token');
    }

    return token;
  }

  invalidate(): void {
    this.client = undefined;
    this.loginPromise = undefined;
  }

  private async getClient(): Promise<GVPlatform> {
    if (
      this.client?.bearerToken &&
      this.tokenIsUsable(this.client.bearerToken)
    ) {
      return this.client;
    }

    if (this.loginPromise === undefined) {
      this.loginPromise = this.login();
    }

    try {
      this.client = await this.loginPromise;
      return this.client;
    } catch (error) {
      this.invalidate();
      throw new BadGatewayException(
        `Unable to authenticate AMPP proxy: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    } finally {
      this.loginPromise = undefined;
    }
  }

  private async login(): Promise<GVPlatform> {
    const client = new GVPlatform(
      this.config.getOrThrow<string>('PLATFORM_URL'),
      this.config.getOrThrow<string>('API_KEY'),
    );

    await client.login();
    return client;
  }

  private tokenIsUsable(token: string): boolean {
    try {
      const payload = token.split('.')[1];

      if (!payload) {
        return true;
      }

      const decoded = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf8'),
      ) as { exp?: unknown };

      return (
        typeof decoded.exp !== 'number' ||
        decoded.exp * 1000 > Date.now() + TOKEN_REFRESH_MARGIN_MS
      );
    } catch {
      return true;
    }
  }
}
