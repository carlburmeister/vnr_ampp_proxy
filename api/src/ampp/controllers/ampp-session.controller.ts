import { Controller, Get, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';

import {
  rejectExpiredSession,
  SessionAuthGuard,
  hasPendingAuthorizationSave,
  PersistSessionInController,
} from '../../auth/session-auth.guard';
import {
  MysqlSessionStore,
  SessionExpiredError,
} from '../../auth/mysql-session.store';

@Controller('ampp/session')
@UseGuards(SessionAuthGuard)
export class AmppSessionController {
  constructor(private readonly config: ConfigService) {}

  @Get('current')
  @PersistSessionInController(true)
  async current(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    // Persist this poll's rolling renewal before publishing its deadline.
    req.session.touch();
    let expiresAt: number;
    try {
      if (!(req.sessionStore instanceof MysqlSessionStore))
        throw new Error('Session renewal requires MysqlSessionStore');
      expiresAt = await req.sessionStore.persistCurrentPoll(
        req.sessionID,
        req.session,
        hasPendingAuthorizationSave(req),
      );
    } catch (error) {
      if (!(error instanceof SessionExpiredError)) throw error;
      return rejectExpiredSession(req, res, this.config);
    }
    return {
      serverTime: Date.now(),
      expiresAt,
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
