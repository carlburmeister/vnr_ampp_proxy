import {
  All,
  BadRequestException,
  Controller,
  ConflictException,
  HttpException,
  Param,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { SessionAuthGuard } from '../auth/session-auth.guard';
import { renewSessionForResponse } from '../auth/session-renewal';
import { AmppProxyPolicyService } from './ampp-proxy-policy.service';
import { AmppProxyService } from './ampp-proxy.service';
import { AmppProxySessionService } from './ampp-proxy-session.service';
import type { AmppBrowserResponse } from './ampp-response-rewriter.service';
import { GvuiPollRetry } from './gvui/gvui-poll-retry';
import { GVUI_MAILBOX_LIMIT, pruneGvuiMailboxes } from './gvui/gvui-mailboxes';
// TEMP AMPP trace: remove with diagnostics/ampp-proxy-trace.ts.
import { tracePhase } from './diagnostics/ampp-proxy-trace';

@Controller('ampp-proxy')
@UseGuards(SessionAuthGuard)
export class AmppApiProxyController {
  private readonly pollRetry = new GvuiPollRetry();

  constructor(
    private readonly policy: AmppProxyPolicyService,
    private readonly proxy: AmppProxyService,
    private readonly proxySession: AmppProxySessionService,
  ) {}

  @All('api/:workloadId/*upstreamPath')
  async proxyApiRequest(
    @Param('workloadId') workloadId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    let sessionSnapshot = this.proxySession.snapshot(req.session);
    const method = req.method.toUpperCase();
    const upstreamPath = this.getUpstreamPath(req, workloadId);
    const body = this.getRawBody(req);
    const creation =
      workloadId.startsWith('gvui-') &&
      method === 'POST' &&
      /^\/notifications\/api\/v1\/mailbox\/?$/i.test(upstreamPath);
    let upstreamResponse: AmppBrowserResponse;
    let recorderOperation = false;
    const routingController = new AbortController();
    const cancelRouting = () => {
      if (!res.writableEnded) routingController.abort();
    };
    res.once('close', cancelRouting);
    try {
      const allowedPath = tracePhase('policy', () =>
        this.policy.assertApiAccess(
          req.session,
          workloadId,
          method,
          upstreamPath,
          body,
        ),
      );
      if (creation) pruneGvuiMailboxes(req.session);
      if (
        creation ||
        (workloadId.startsWith('gvui-') &&
          /^\/notifications\/api\/v1\/(?:notifications|mailbox)\/[^/]+/i.test(
            upstreamPath,
          ))
      ) {
        // Persist throttled activity before a long poll, so another tab's cleanup
        // sees this alias as active. Saving reloads current grants/ownership.
        await tracePhase('session.merge', () =>
          this.proxySession.saveIfChanged(req, sessionSnapshot),
        );
        sessionSnapshot = this.proxySession.snapshot(req.session);
        tracePhase('policy.recheck', () =>
          this.policy.assertApiAccess(
            req.session,
            workloadId,
            method,
            upstreamPath,
            body,
          ),
        );
      }
      if (creation) {
        const data = JSON.parse(body.toString()) as { id: string };
        if (
          Object.keys(req.session.gvuiMailboxes ?? {}).length >=
            GVUI_MAILBOX_LIMIT &&
          !req.session.gvuiMailboxes?.[data.id]
        )
          throw new ConflictException('Too many open GV.UI mailboxes');
      }
      upstreamResponse = await tracePhase('proxy.api', () =>
        this.proxy.proxyApiRequest(
          req.sessionID,
          req.session,
          workloadId,
          method,
          allowedPath,
          req.headers,
          body,
          this.getPublicOrigin(req),
          {
            signal: routingController.signal,
            assertActive: async () => {
              recorderOperation = true;
              await this.proxySession.assertAuthorizationCurrent(req);
              this.policy.assertApiAccess(
                req.session,
                workloadId,
                method,
                upstreamPath,
                body,
              );
            },
          },
        ),
      );

      await tracePhase('session.merge', () =>
        this.proxySession.saveIfChanged(req, sessionSnapshot),
      );
    } catch (error) {
      // Retain token invalidation/cache updates on a failed recorder workflow.
      // saveIfChanged still refuses revoked or deleted sessions.
      if (recorderOperation)
        await this.proxySession.saveIfChanged(req, sessionSnapshot);
      await this.pollRetry.complete(
        req.sessionID,
        workloadId,
        method,
        upstreamPath,
        error instanceof HttpException ? error.getStatus() : 500,
        res,
      );
      if (res.destroyed) return;
      throw error;
    } finally {
      res.off('close', cancelRouting);
    }

    if (
      creation &&
      upstreamResponse.status >= 200 &&
      upstreamResponse.status < 300
    ) {
      try {
        const data = JSON.parse(upstreamResponse.body.toString()) as {
          id?: unknown;
        };
        if (typeof data.id === 'string')
          this.pollRetry.reset(req.sessionID, workloadId, data.id);
      } catch {
        // An invalid mailbox response is rejected by GvuiProxyService upstream.
      }
    }
    await this.pollRetry.complete(
      req.sessionID,
      workloadId,
      method,
      upstreamPath,
      upstreamResponse.status,
      res,
    );
    if (res.destroyed) return;

    await renewSessionForResponse(req);
    if (res.destroyed) return;
    res.status(upstreamResponse.status);

    for (const [name, value] of Object.entries(upstreamResponse.headers)) {
      res.setHeader(name, value);
    }

    if (
      req.method === 'HEAD' ||
      upstreamResponse.status === 204 ||
      upstreamResponse.status === 304
    ) {
      res.end();
      return;
    }

    res.send(upstreamResponse.body);
  }

  private getUpstreamPath(req: Request, workloadId: string): string {
    const requestUrl = new URL(req.originalUrl, 'http://ampp-proxy.local');
    const proxyPrefix =
      `/api/ampp-proxy/api/${encodeURIComponent(workloadId)}`;

    if (!requestUrl.pathname.startsWith(proxyPrefix)) {
      throw new BadRequestException('Invalid AMPP API proxy path');
    }

    const pathname = requestUrl.pathname.slice(proxyPrefix.length) || '/';
    return `${pathname}${requestUrl.search}`;
  }

  private getRawBody(req: Request): Buffer | undefined {
    if (req.body === undefined || req.body === null) {
      return undefined;
    }

    if (!Buffer.isBuffer(req.body)) {
      throw new BadRequestException(
        'AMPP API request body was not captured as raw bytes',
      );
    }

    return req.body.length ? req.body : undefined;
  }

  private getPublicOrigin(req: Request): string {
    const forwardedProtocol = this.firstHeader(
      req.headers['x-forwarded-proto'],
    );
    const forwardedHost = this.firstHeader(req.headers['x-forwarded-host']);
    const protocol = forwardedProtocol?.split(',')[0].trim() || req.protocol;
    const host = forwardedHost?.split(',')[0].trim() || req.get('host');

    if (!host) {
      throw new BadRequestException('Unable to determine proxy host');
    }

    try {
      return new URL(`${protocol}://${host}`).origin;
    } catch {
      throw new BadRequestException('Invalid proxy host');
    }
  }

  private firstHeader(
    value: string | string[] | undefined,
  ): string | undefined {
    return Array.isArray(value) ? value[0] : value;
  }
}
