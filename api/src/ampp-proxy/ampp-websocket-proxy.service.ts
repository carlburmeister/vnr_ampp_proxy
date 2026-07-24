import {
  HttpException,
  Injectable,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, RequestHandler, Response } from 'express';
import type { SessionData } from 'express-session';
import {
  type IncomingMessage,
  type Server,
  ServerResponse,
} from 'node:http';
import type { Duplex } from 'node:stream';
import { CookieJar } from 'tough-cookie';

import {
  amppProxySessionDebugLog,
  amppProxySessionDebugWarn,
} from './ampp-proxy-session-debug';
import { AmppProxyPolicyService } from './ampp-proxy-policy.service';

type WebSocketData = Buffer | ArrayBuffer | Buffer[] | string;

type WebSocketConnection = {
  readonly bufferedAmount: number;
  readonly readyState: number;
  close(code?: number, reason?: string): void;
  on(event: string, listener: (...args: any[]) => void): WebSocketConnection;
  send(
    data: WebSocketData,
    options: { binary: boolean },
    callback?: (error?: Error) => void,
  ): void;
  terminate(): void;
};

type WebSocketServer = {
  close(): void;
  handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    callback: (socket: WebSocketConnection) => void,
  ): void;
};

type WebSocketConstructor = {
  new (
    url: string,
    protocols: string[] | undefined,
    options: { headers: Record<string, string> },
  ): WebSocketConnection;
  readonly CONNECTING: number;
  readonly OPEN: number;
  readonly CLOSING: number;
  readonly Server: new (options: { noServer: boolean }) => WebSocketServer;
};

const WebSocket = require('ws') as WebSocketConstructor;

const MAX_PENDING_BYTES = 1024 * 1024;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const WEBSOCKET_PROXY_PREFIX = '/api/ampp-proxy/ws/';

type UpgradeRequest = IncomingMessage & {
  session?: SessionData;
  sessionID?: string;
};

type ParsedProxyRequest = {
  workloadId: string;
  upstreamPath: string;
};

type PendingMessage = {
  data: WebSocketData;
  isBinary: boolean;
  size: number;
};

@Injectable()
export class AmppWebSocketProxyService implements OnModuleDestroy {
  private readonly browserServer = new WebSocket.Server({ noServer: true });
  private readonly platformUrl: URL;
  private sessionMiddleware?: RequestHandler;
  private server?: Server;

  constructor(
    private readonly config: ConfigService,
    private readonly policy: AmppProxyPolicyService,
  ) {
    this.platformUrl = new URL(
      this.config.getOrThrow<string>('PLATFORM_URL'),
    );
  }

  attach(server: Server, sessionMiddleware: RequestHandler): void {
    if (this.server) {
      return;
    }

    this.server = server;
    this.sessionMiddleware = sessionMiddleware;
    this.server.on('upgrade', this.handleUpgrade);
  }

  onModuleDestroy(): void {
    this.server?.off('upgrade', this.handleUpgrade);
    this.browserServer.close();
  }

  private readonly handleUpgrade = (
    request: UpgradeRequest,
    socket: Duplex,
    head: Buffer,
  ): void => {
    const parsedRequest = this.parseProxyRequest(request.url);

    if (!parsedRequest) {
      return;
    }

    socket.on('error', () => undefined);

    void this.authorizeUpgrade(request, parsedRequest)
      .then((allowedPath) => {
        this.browserServer.handleUpgrade(request, socket, head, (browser) => {
          void this.connectUpstream(browser, request, allowedPath).catch(
            (error) => {
              amppProxySessionDebugWarn(
                `AMPP WebSocket setup failed path=${allowedPath}: ${
                  error instanceof Error ? error.message : 'unknown error'
                }`,
                request.sessionID,
              );
              browser.terminate();
            },
          );
        });
      })
      .catch((error) => {
        const status = error instanceof HttpException ? error.getStatus() : 500;
        amppProxySessionDebugWarn(
          `AMPP WebSocket upgrade rejected status=${status} path=${parsedRequest.upstreamPath}`,
          request.sessionID,
        );
        this.rejectUpgrade(socket, status);
      });
  };

  private async authorizeUpgrade(
    request: UpgradeRequest,
    parsedRequest: ParsedProxyRequest,
  ): Promise<string> {
    await this.loadSession(request);

    if (!request.session?.user) {
      throw new HttpException('Login required', 401);
    }

    return this.policy.assertWebSocketAccess(
      request.session,
      parsedRequest.workloadId,
      parsedRequest.upstreamPath,
    );
  }

  private async connectUpstream(
    browser: WebSocketConnection,
    request: UpgradeRequest,
    upstreamPath: string,
  ): Promise<void> {
    const pendingMessages: PendingMessage[] = [];
    let pendingBytes = 0;
    let upstream: WebSocketConnection | undefined;
    let browserClosed = false;

    browser.on('close', (code: number, reason: unknown) => {
      browserClosed = true;

      if (upstream) {
        this.closePeer(upstream, code, reason);
      }
    });

    browser.on('error', () => {
      browserClosed = true;
      upstream?.terminate();
    });

    browser.on('message', (data: WebSocketData) => {
      const isBinary = typeof data !== 'string';

      if (upstream?.readyState === WebSocket.OPEN) {
        this.relay(browser, upstream, data, isBinary);
        return;
      }

      if (upstream && upstream.readyState !== WebSocket.CONNECTING) {
        return;
      }

      const size = this.messageSize(data);
      pendingBytes += size;

      if (pendingBytes > MAX_PENDING_BYTES) {
        browser.close(1009, 'WebSocket message queue exceeded');
        upstream?.terminate();
        return;
      }

      pendingMessages.push({ data, isBinary, size });
    });

    const upstreamUrl = new URL(upstreamPath, this.platformUrl);
    upstreamUrl.protocol =
      this.platformUrl.protocol === 'https:' ? 'wss:' : 'ws:';

    const headers: Record<string, string> = {
      Origin: this.platformUrl.origin,
    };
    const userAgent = this.firstHeader(request.headers['user-agent']);
    const correlationId = this.firstHeader(request.headers['x-correlation-id']);
    const cookie = await this.getUpstreamCookie(
      request.session,
      upstreamUrl.toString(),
    );

    if (userAgent) {
      headers['User-Agent'] = userAgent;
    }

    if (correlationId) {
      headers['X-Correlation-Id'] = correlationId;
    }

    if (cookie) {
      headers.Cookie = cookie;
    }

    if (browserClosed) {
      return;
    }

    const protocols = this.parseProtocols(
      this.firstHeader(request.headers['sec-websocket-protocol']),
    );
    upstream = new WebSocket(
      upstreamUrl.toString(),
      protocols.length ? protocols : undefined,
      { headers },
    );

    amppProxySessionDebugLog(
      `Connecting AMPP WebSocket path=${upstreamPath}`,
      request.sessionID,
    );

    upstream.on('open', () => {
      amppProxySessionDebugLog(
        `AMPP WebSocket connected path=${upstreamPath}`,
        request.sessionID,
      );

      for (const message of pendingMessages.splice(0)) {
        pendingBytes -= message.size;
        this.relay(browser, upstream, message.data, message.isBinary);
      }
    });

    upstream.on('message', (data: WebSocketData) => {
      this.relay(upstream, browser, data, typeof data !== 'string');
    });

    upstream.on('close', (code: number, reason: unknown) => {
      amppProxySessionDebugLog(
        `AMPP WebSocket closed code=${code} path=${upstreamPath}`,
        request.sessionID,
      );
      this.closePeer(browser, code, reason);
    });

    upstream.on('error', (error: Error) => {
      amppProxySessionDebugWarn(
        `AMPP WebSocket error path=${upstreamPath}: ${error.message}`,
        request.sessionID,
      );
      browser.terminate();
    });

    upstream.on('unexpected-response', (_upgradeRequest, response) => {
      response.resume();
      amppProxySessionDebugWarn(
        `AMPP WebSocket rejected status=${response.statusCode ?? 0} path=${upstreamPath}`,
        request.sessionID,
      );
      browser.close(1011, 'AMPP WebSocket rejected');
    });
  }

  private relay(
    source: WebSocketConnection,
    target: WebSocketConnection,
    data: WebSocketData,
    isBinary: boolean,
  ): void {
    if (target.readyState !== WebSocket.OPEN) {
      return;
    }

    if (target.bufferedAmount >= MAX_BUFFERED_BYTES) {
      source.terminate();
      target.terminate();
      return;
    }

    try {
      target.send(data, { binary: isBinary }, (error) => {
        if (error) {
          source.terminate();
          target.terminate();
        }
      });
    } catch {
      source.terminate();
      target.terminate();
    }
  }

  private closePeer(
    peer: WebSocketConnection,
    code: number,
    reason: unknown,
  ): void {
    if (peer.readyState === WebSocket.OPEN) {
      const safeCode =
        code >= 1000 &&
        code <= 4999 &&
        ![1004, 1005, 1006, 1015].includes(code)
          ? code
          : 1000;

      peer.close(safeCode, this.normalizeCloseReason(reason));
      return;
    }

    if (peer.readyState === WebSocket.CONNECTING) {
      peer.terminate();
    }
  }

  private normalizeCloseReason(reason: unknown): string {
    let text = '';

    if (Buffer.isBuffer(reason)) {
      text = reason.toString('utf8');
    } else if (reason instanceof ArrayBuffer) {
      text = Buffer.from(reason).toString('utf8');
    } else if (ArrayBuffer.isView(reason)) {
      text = Buffer.from(
        reason.buffer,
        reason.byteOffset,
        reason.byteLength,
      ).toString('utf8');
    } else if (typeof reason === 'string') {
      text = reason;
    }

    let result = '';

    for (const character of text) {
      if (Buffer.byteLength(result + character, 'utf8') > 123) {
        break;
      }

      result += character;
    }

    return result;
  }

  private loadSession(request: UpgradeRequest): Promise<void> {
    if (!this.sessionMiddleware) {
      return Promise.reject(new Error('WebSocket session middleware is missing'));
    }

    const response = new ServerResponse(request);

    return new Promise<void>((resolve, reject) => {
      this.sessionMiddleware?.(
        request as unknown as Request,
        response as unknown as Response,
        (error?: unknown) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        },
      );
    });
  }

  private parseProxyRequest(urlValue?: string): ParsedProxyRequest | null {
    if (!urlValue) {
      return null;
    }

    try {
      const requestUrl = new URL(urlValue, 'http://ampp-proxy.local');

      if (!requestUrl.pathname.startsWith(WEBSOCKET_PROXY_PREFIX)) {
        return null;
      }

      const remainder = requestUrl.pathname.slice(WEBSOCKET_PROXY_PREFIX.length);
      const separatorIndex = remainder.indexOf('/');

      if (separatorIndex <= 0) {
        return {
          workloadId: '',
          upstreamPath: '/',
        };
      }

      const workloadId = decodeURIComponent(remainder.slice(0, separatorIndex));
      const upstreamPath = `${remainder.slice(separatorIndex)}${requestUrl.search}`;

      return { workloadId, upstreamPath };
    } catch {
      return {
        workloadId: '',
        upstreamPath: '/',
      };
    }
  }

  private async getUpstreamCookie(
    session: SessionData | undefined,
    upstreamUrl: string,
  ): Promise<string> {
    if (!session?.amppCookieJar) {
      return '';
    }

    return CookieJar.fromJSON(session.amppCookieJar).getCookieString(
      upstreamUrl.replace(/^ws/i, 'http'),
    );
  }

  private parseProtocols(value?: string): string[] {
    return value
      ? value
          .split(',')
          .map((protocol) => protocol.trim())
          .filter(Boolean)
      : [];
  }

  private messageSize(data: WebSocketData): number {
    if (typeof data === 'string') {
      return Buffer.byteLength(data);
    }

    if (Array.isArray(data)) {
      return data.reduce((total, part) => total + part.length, 0);
    }

    if (data instanceof ArrayBuffer) {
      return data.byteLength;
    }

    return data.length;
  }

  private rejectUpgrade(socket: Duplex, status: number): void {
    const safeStatus = [400, 401, 403].includes(status) ? status : 500;
    const statusText =
      safeStatus === 400
        ? 'Bad Request'
        : safeStatus === 401
          ? 'Unauthorized'
          : safeStatus === 403
            ? 'Forbidden'
            : 'Internal Server Error';

    socket.end(
      `HTTP/1.1 ${safeStatus} ${statusText}\r\n` +
        'Connection: close\r\n' +
        'Content-Length: 0\r\n\r\n',
    );
  }

  private firstHeader(
    value: string | string[] | undefined,
  ): string | undefined {
    return Array.isArray(value) ? value[0] : value;
  }
}
