import {
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
import { AmppProxyService } from './ampp-proxy.service';

@Controller('ampp-proxy')
@UseGuards(SessionAuthGuard)
export class AmppProxyController {
  constructor(
    private readonly policy: AmppProxyPolicyService,
    private readonly proxy: AmppProxyService,
  ) {}

  @Get('ui/:workloadId')
  async getUiPage(
    @Param('workloadId') workloadId: string,
    @Query('path') upstreamPath: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const allowedPath = this.policy.assertUiAccess(
      req.session,
      workloadId,
      upstreamPath,
    );

    const upstreamResponse = await this.proxy.getUiPage(allowedPath);

    res.status(upstreamResponse.status);
    res.setHeader('Content-Type', upstreamResponse.contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.removeHeader('Set-Cookie');
    res.send(upstreamResponse.body);
  }
}
