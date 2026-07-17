import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';

import { SessionAuthGuard } from '../../auth/session-auth.guard';

@Controller('ampp/session')
@UseGuards(SessionAuthGuard)
export class AmppSessionController {
  @Get('current')
  current(@Req() req: Request) {
    return {
      user: req.session.user,
      parentWorkloadId: req.session.parentWorkloadId,
      fabricId: req.session.fabricId,
      nodeId: req.session.nodeId,
      allowedWorkloads: req.session.allowedWorkloads ?? [],
    };
  }
}
