import {
  Body, Controller, Get, ParseIntPipe, Param, Put, Req, UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { SessionAuthGuard } from '../../auth/session-auth.guard';
import { ReplacePermissionsDto } from '../dto/replace-permissions.dto';
import { ClientPermissionsService } from '../services/client-permissions.service';

@Controller('user-management')
@UseGuards(SessionAuthGuard)
export class ClientPermissionsController {
  constructor(private readonly permissions: ClientPermissionsService) {}

  @Get('users')
  listUsers(@Req() req: Request) {
    return this.permissions.listUsers(req.session.user!);
  }

  @Get('resources')
  listResources(@Req() req: Request) {
    return this.permissions.listResources(req.session.user!);
  }

  @Get('workloads/:workloadId/children')
  listChildWorkloads(@Req() req: Request, @Param('workloadId', ParseIntPipe) workloadId: number) {
    return this.permissions.listChildWorkloads(req.session.user!, workloadId);
  }

  @Get('users/:userId/permissions')
  getPermissions(@Req() req: Request, @Param('userId', ParseIntPipe) userId: number) {
    return this.permissions.getPermissions(req.session.user!, userId);
  }

  @Put('users/:userId/permissions')
  replacePermissions(
    @Req() req: Request,
    @Param('userId', ParseIntPipe) userId: number,
    @Body() changes: ReplacePermissionsDto,
  ) {
    return this.permissions.replacePermissions(req.session.user!, userId, changes).then((result) => {
      // Force the current user's refreshed permissions on their next session request.
      if (Number(req.session.user!.id) === userId) req.session.authorizationCheckedAt = 0;
      return result;
    });
  }
}
