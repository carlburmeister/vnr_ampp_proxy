import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { SessionAuthGuard } from '../auth/session-auth.guard';
import { AmppProxyPolicyService } from './ampp-proxy-policy.service';
import { AmppResponseRewriterService } from './ampp-response-rewriter.service';
import { AmppProxyService } from './ampp-proxy.service';
import { AmppProxySessionService } from './ampp-proxy-session.service';

@Controller('ampp-proxy')
@UseGuards(SessionAuthGuard)
export class AmppProxyController {
  constructor(
    private readonly policy: AmppProxyPolicyService,
    private readonly responseRewriter: AmppResponseRewriterService,
    private readonly proxy: AmppProxyService,
    private readonly proxySession: AmppProxySessionService,
  ) {}

  @Get('ui/:workloadId')
  redirectLegacyUiPage(
    @Param('workloadId') workloadId: string,
    @Query('path') upstreamPath: string,
    @Req() req: Request,
    @Res() res: Response,
  ): void {
    const allowedPath = this.policy.assertUiAccess(
      req.session,
      workloadId,
      upstreamPath,
    );

    res.redirect(
      302,
      this.responseRewriter.createProxyPath(workloadId, allowedPath),
    );
  }

  @Get('ui/:workloadId/*upstreamPath')
  async getUiResource(
    @Param('workloadId') workloadId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const sessionSnapshot = this.proxySession.snapshot(req.session);
    const upstreamPath = this.getUpstreamPath(req, workloadId);
    const allowedPath = this.isWorkloadPagePath(upstreamPath, workloadId)
      ? this.policy.assertUiAccess(req.session, workloadId, upstreamPath)
      : this.policy.assertUiResourceAccess(
          req.session,
          workloadId,
          upstreamPath,
        );
    const upstreamResponse = await this.proxy.getUiResource(
      req.sessionID,
      req.session,
      workloadId,
      allowedPath,
      req.headers,
      this.getPublicOrigin(req),
    );

    await this.proxySession.saveIfChanged(req, sessionSnapshot);

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
      `/api/ampp-proxy/ui/${encodeURIComponent(workloadId)}`;

    if (!requestUrl.pathname.startsWith(proxyPrefix)) {
      throw new BadRequestException('Invalid AMPP proxy path');
    }

    const pathname = requestUrl.pathname.slice(proxyPrefix.length) || '/';
    return `${pathname}${requestUrl.search}`;
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

  private isWorkloadPagePath(
    upstreamPath: string,
    workloadId: string,
  ): boolean {
    const target = new URL(upstreamPath, 'http://ampp-proxy.local');
    return (
      target.pathname
        .split('/')
        .filter(Boolean)
        .map((segment) => decodeURIComponent(segment))
        .includes(workloadId) ||
      [...target.searchParams.values()].includes(workloadId)
    );
  }

  private firstHeader(
    value: string | string[] | undefined,
  ): string | undefined {
    return Array.isArray(value) ? value[0] : value;
  }
}
