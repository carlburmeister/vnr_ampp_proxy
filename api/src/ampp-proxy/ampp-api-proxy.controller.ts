import {
  All,
  BadRequestException,
  Controller,
  Param,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { SessionAuthGuard } from '../auth/session-auth.guard';
import { AmppProxyPolicyService } from './ampp-proxy-policy.service';
import { AmppProxyService } from './ampp-proxy.service';

@Controller('ampp-proxy')
@UseGuards(SessionAuthGuard)
export class AmppApiProxyController {
  constructor(
    private readonly policy: AmppProxyPolicyService,
    private readonly proxy: AmppProxyService,
  ) {}

  @All('api/:workloadId/*upstreamPath')
  async proxyApiRequest(
    @Param('workloadId') workloadId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const method = req.method.toUpperCase();
    const upstreamPath = this.getUpstreamPath(req, workloadId);
    const body = this.getRawBody(req);
    const allowedPath = this.policy.assertApiAccess(
      req.session,
      workloadId,
      method,
      upstreamPath,
      body,
    );
    const upstreamResponse = await this.proxy.proxyApiRequest(
      req.sessionID,
      req.session,
      workloadId,
      method,
      allowedPath,
      req.headers,
      body,
      this.getPublicOrigin(req),
    );

    await this.saveSession(req);

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

  private saveSession(req: Request): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      req.session.save((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  private firstHeader(
    value: string | string[] | undefined,
  ): string | undefined {
    return Array.isArray(value) ? value[0] : value;
  }
}
