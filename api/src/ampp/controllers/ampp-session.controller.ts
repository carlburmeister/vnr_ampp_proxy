import { Controller, Get, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';

import {
  rejectExpiredSession,
  SessionAuthGuard,
} from '../../auth/session-auth.guard';
import { SessionExpiredError } from '../../auth/mysql-session.store';

@Controller('ampp/session')
@UseGuards(SessionAuthGuard)
export class AmppSessionController {
  constructor(private readonly config: ConfigService) {}

  @Get('current')
  async current(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    // Persist this poll's rolling renewal before publishing its deadline.
    req.session.touch();
    try {
      await new Promise<void>((resolve, reject) => {
        req.session.save((error?: Error) =>
          error ? reject(error) : resolve(),
        );
      });
    } catch (error) {
      if (!(error instanceof SessionExpiredError)) throw error;
      return rejectExpiredSession(req, res, this.config);
    }
    return {
      serverTime: Date.now(),
      expiresAt: req.session.cookie.expires.getTime(),
      user: req.session.user,
      parentWorkloadId: req.session.parentWorkloadId,
      fabricId: req.session.fabricId,
      nodeId: req.session.nodeId,
      allowedWorkloads: req.session.allowedWorkloads ?? [],
      allowedDashboards: req.session.allowedDashboards ?? [],
      allowedGvuiLayoutIds: req.session.allowedGvuiLayoutIds ?? [],
      allowedGvuiLayouts: req.session.allowedGvuiLayouts ?? [],
    };
  }
}
