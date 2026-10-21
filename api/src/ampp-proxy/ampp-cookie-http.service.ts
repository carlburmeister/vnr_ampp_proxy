import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { type Method } from 'axios';
import { CookieJar } from 'tough-cookie';

import { amppProxySessionDebugLog } from './ampp-proxy-session-debug';

export type AmppCookieHttpResponse = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  url: string;
};

type AmppCookieHttpRequest = {
  method?: Method;
  headers?: Record<string, string>;
  data?: string | Buffer;
  followRedirects?: boolean;
};

@Injectable()
export class AmppCookieHttpService {
  private readonly platformUrl: URL;
  private readonly logger = new Logger(AmppCookieHttpService.name);

  constructor(private readonly config: ConfigService) {
    this.platformUrl = new URL(
      this.config.getOrThrow<string>('PLATFORM_URL'),
    );
  }

  async request(
    cookieJar: CookieJar,
    pathOrUrl: string,
    request: AmppCookieHttpRequest = {},
  ): Promise<AmppCookieHttpResponse> {
    let url = this.resolveAllowedUrl(pathOrUrl, this.platformUrl);
    let method = request.method ?? 'GET';
    let data = request.data;
    let headers = { ...(request.headers ?? {}) };

    for (let redirectCount = 0; redirectCount <= 10; redirectCount += 1) {
      const cookie = await cookieJar.getCookieString(url.toString());

      const startedAt = Date.now();
      try {
        const response = await axios.request<ArrayBuffer>({
          url: url.toString(),
          method,
          data,
          headers: {
            ...headers,
            ...(cookie ? { Cookie: cookie } : {}),
          },
          maxRedirects: 0,
          responseType: 'arraybuffer',
          validateStatus: () => true,
        });

        if (response.status >= 500) {
          // Log only the path: OAuth query parameters can contain credentials.
          this.logger.warn(
            `AMPP upstream HTTP ${response.status} ${method} ${url.pathname} ` +
              `(${Date.now() - startedAt}ms)`,
          );
        }

        await this.storeResponseCookies(
          cookieJar,
          url,
          response.headers['set-cookie'],
        );

        const location = response.headers.location;
        const isRedirect =
          response.status >= 300 &&
          response.status < 400 &&
          Boolean(location);

        if (!request.followRedirects || !isRedirect) {
          return {
            status: response.status,
            headers: response.headers as Record<
              string,
              string | string[] | undefined
            >,
            body: Buffer.from(response.data),
            url: url.toString(),
          };
        }

        if (redirectCount === 10) {
          throw new BadGatewayException(
            'AMPP exceeded the proxy redirect limit',
          );
        }

        const redirectUrl = this.resolveAllowedUrl(String(location), url);

        amppProxySessionDebugLog(
          `Following AMPP redirect status=${response.status} from=${url.toString()} to=${redirectUrl.toString()}`,
        );

        url = redirectUrl;

        if (
          response.status === 303 ||
          ((response.status === 301 || response.status === 302) &&
            method.toUpperCase() === 'POST')
        ) {
          method = 'GET';
          data = undefined;
          headers = this.removeEntityHeaders(headers);
        }
      } catch (error) {
        if (error instanceof BadGatewayException) {
          throw error;
        }

        const code = axios.isAxiosError(error) ? error.code : undefined;
        this.logger.warn(
          `AMPP transport failure ${method} ${url.pathname} ` +
            `(${Date.now() - startedAt}ms${code ? `, ${code}` : ''})`,
        );
        throw new BadGatewayException('Unable to reach AMPP');
      }
    }

    throw new BadGatewayException('AMPP exceeded the proxy redirect limit');
  }

  private resolveAllowedUrl(pathOrUrl: string, baseUrl: URL): URL {
    const url = new URL(pathOrUrl, baseUrl);

    if (url.origin !== this.platformUrl.origin) {
      throw new BadGatewayException(
        `AMPP redirected to an unexpected origin: ${url.origin}`,
      );
    }

    return url;
  }

  private async storeResponseCookies(
    cookieJar: CookieJar,
    url: URL,
    setCookieHeaders?: string | string[],
  ): Promise<void> {
    const headers = Array.isArray(setCookieHeaders)
      ? setCookieHeaders
      : setCookieHeaders
        ? [setCookieHeaders]
        : [];

    for (const setCookieHeader of headers) {
      await cookieJar.setCookie(setCookieHeader, url.toString(), {
        ignoreError: true,
      });
    }
  }

  private removeEntityHeaders(
    headers: Record<string, string>,
  ): Record<string, string> {
    return Object.fromEntries(
      Object.entries(headers).filter(
        ([name]) =>
          !['content-type', 'content-length'].includes(name.toLowerCase()),
      ),
    );
  }
}
