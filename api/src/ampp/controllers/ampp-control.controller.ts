import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  MessageEvent,
  Param,
  Post,
  Req,
  Sse,
  UseGuards,
} from '@nestjs/common';

import type { Request } from 'express';
import { concatMap, filter, map, Observable } from 'rxjs';

import { SessionAuthGuard } from '../../auth/session-auth.guard';
import { AuthService } from '../../auth/auth.service';
import { AmppControlService } from '../services/ampp-control.service';
import type { AllowedWorkload } from '../types/workload_types';


@Controller('ampp/control')
@UseGuards(SessionAuthGuard)
export class AmppControlController {
  constructor(
    private readonly amppControl: AmppControlService,
    private readonly auth: AuthService,
  ) {}

  @Get('application-types')
  listApplicationTypes() {
    return this.amppControl.listApplicationTypes();
  }

  @Get('application-types/:application/workloads')
  async listWorkloadsForApplicationType(@Param('application') application: string) {
    return this.amppControl.listWorkloadsForApplicationType(application);
  }

  @Get('application-types/:application/workload-names')
  async listWorkloadNamesForApplicationType(
    @Param('application') application: string,
    @Req() req: Request,
  ) {
    const workloads = await this.amppControl.listWorkloadNamesForApplicationType(application);
    
    const allowedIds = this.getAllowedWorkloadIds(req);

    if (!allowedIds.length) {
      //return workloads;   // <== This allows any/all workloads...?
      return [];
    }

    return workloads.filter((workload: any) => allowedIds.includes(workload.id?.toLowerCase()));
  }

  /*--------------------------------------------------------------------*/
  //  getWorkload()
  //  NOTE: This is only needed if getWorkload() is called from React/web page.
  /*--------------------------------------------------------------------*/
  @Get('workloads/:workload_id')
  async getWorkload(
    @Param('workload_id') workload_id: string,
    @Req() req: Request,
  ) {
    this.assertWorkloadAllowed(req, workload_id);

    const workload = await this.amppControl.getWorkload(workload_id);    

    return workload;
  }

  /*--------------------------------------------------------------------*/
  //  listChildWorkloads()
  //  NOTE: This is only needed if listChildWorkloads() is called from React/web page.
  /*--------------------------------------------------------------------*/
  @Get('workloads/:workload_id/child-workloads')
  async listChildWorkloads(
    @Param('workload_id') workload_id: string,
    @Req() req: Request,
  ) {
    this.assertWorkloadAllowed(req, workload_id);

    const workloads = await this.amppControl.listChildWorkloads(workload_id);
    const allowedIds = new Set(this.getAllowedWorkloadIds(req));
    return {
      ...workloads,
      workloads: (workloads.workloads ?? []).filter(
        (item) => allowedIds.has(item.workload.id.toLowerCase()),
      ),
    };
  }

  @Get('workloads/:workload_id/config')
  async getApplicationConfig(
    @Param('workload_id') workload_id: string,
    @Req() req: Request,
  ) {
    this.assertWorkloadAllowed(req, workload_id);

    return this.amppControl.getApplicationConfig(workload_id);
  }


  @Get('workloads/:workload_id/state')
  async getApplicationState(
    @Param('workload_id') workload_id: string,
    @Req() req: Request,
  ) {
    this.assertWorkloadAllowed(req, workload_id);

    return this.amppControl.getApplicationState(workload_id);
  }


  @Get('application-types/:application/control-schemas')
  getControlSchemasForApplication(@Param('application') application: string) {
    return this.amppControl.getControlSchemasForApplication(application);
  }

  @Get('macros')
  listMacros() {
    // Macros are not linked to client workloads in the current DB schema.
    return [];
  }

  @Post('macros/:uuid/execute')
  executeMacro(
    @Param('uuid') uuid: string,
    @Body() body?: { reconKey?: string },
  ) {
    throw new ForbiddenException('Macros require explicit workload-scoped authorization');
  }

  @Post('message')
  sendControlMessage(
    @Body()
    body: {
      workload: string;
      application: string;
      command: string;
      payload: unknown;
      reconKey?: string;
    },
    @Req() req: Request,
  ) {
    this.assertWorkloadAllowed(req, body.workload);
    return this.amppControl.sendControlMessage(body);
  }

  @Post('get-state')
  getState(
    @Body() body: { workloadId?: string; reconKey?: string },
    @Req() req: Request,
  ) {
    this.assertWorkloadAllowed(req, body.workloadId);
    return this.amppControl.getState(body);
  }

  @Post('program-preview-control-state')
  sendProgramPreviewControlState(
    @Body()
    body: {
      workloadId?: string;
      applicationName?: string;
      index?: number;
      isProgram?: boolean;
      isPreview?: boolean;
    },
    @Req() req: Request,
  ) {
    this.assertWorkloadAllowed(req, body.workloadId);
    return this.amppControl.sendProgramPreviewControlState(body);
  }

  @Post('key-state')
  sendKeyState(
    @Body()
    body: {
      workloadId?: string;
      applicationName?: string;
      transitionType?: string;
      active?: boolean;
    },
    @Req() req: Request,
  ) {
    this.assertWorkloadAllowed(req, body.workloadId);
    return this.amppControl.sendKeyState(body);
  }

  @Post('notifications/start')
  startNotificationListener() {
    return this.amppControl.startNotificationListener();
  }

  @Post('notifications/subscribe')
  subscribeToNotificationTopic(
    @Body() body: { topic: string },
    @Req() req: Request,
  ) {
    const ids = this.getAllowedWorkloadIds(req);
    const uuids = body.topic?.match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi) ?? [];
    if (uuids.length !== 1 || !ids.includes(uuids[0].toLowerCase()) ||
        /[#+*]/.test(body.topic)) {
      throw new ForbiddenException('Notification topic is not authorized');
    }
    return this.amppControl.subscribeToNotificationTopic(body.topic);
  }

  @Post('workloads/:workload/notifications')
  subscribeToWorkloadNotifications(
    @Param('workload') workload: string,
    @Req() req: Request,
  ) {
    this.assertWorkloadAllowed(req, workload);
    return this.amppControl.subscribeToWorkloadNotifications(workload);
  }

  @Sse('notifications/stream')
  streamNotifications(@Req() req: Request): Observable<MessageEvent> {
    return this.amppControl.notificationEvents().pipe(
      concatMap(async (event): Promise<MessageEvent | null> => {
        // Long-lived streams must not retain revoked permissions.
        await this.auth.refreshSessionAuthorization(req.session);
        const ids = event.data.topic?.match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi) ?? [];
        const allowed = new Set(this.getAllowedWorkloadIds(req));
        return ids.length && ids.every((id) => allowed.has(id.toLowerCase()))
          ? { data: event }
          : null;
      }),
      filter((event): event is MessageEvent => event !== null),
    );
  }

  private getAllowedWorkloadIds(req: Request) {
    const allowedWorkloads: AllowedWorkload[] = req.session.allowedWorkloads ?? [];
    return [...new Set([
      ...allowedWorkloads.flatMap((workload) => [
        workload.id,
        ...(workload.child_workloads ?? []).map((child) => child.id),
      ]),
      ...(req.session.amppAllowedWorkloadIds ?? []),
    ].map((id) => id.toLowerCase()))];
  }

  private assertWorkloadAllowed(req: Request, workloadId?: string) {
    const allowedIds = this.getAllowedWorkloadIds(req);

    if (!allowedIds.length) {
      //return;   // <== This allows any/all workloads...?
      throw new ForbiddenException('No allowed workloads found for this session');
    }

    if (!workloadId || !allowedIds.includes(workloadId.toLowerCase())) {
      throw new ForbiddenException('Workload is not allowed for this session');
    }
  }

  /*--------------------------------------------------------------------*/
  // WebRTC
  /*--------------------------------------------------------------------*/
  @Post('webrtc/session')
  startWebRtcSession(
    @Body() body: { workloadId?: string; engineInstanceId?: string },
    @Req() req: Request,
  ) {
    this.assertWorkloadAllowed(req, body.workloadId);
    return this.amppControl.startWebRtcSession(body);
  }

  @Post('webrtc/signal')
  publishWebRtcSignal(
    @Body()
    body: {
      workloadId?: string;
      engineInstanceId?: string;
      topic?: string;
      content?: unknown;
    },
    @Req() req: Request,
  ) {
    this.assertWorkloadAllowed(req, body.workloadId);
    return this.amppControl.publishWebRtcSignal(body);
  }

  @Sse('webrtc/stream')
  streamWebRtcSignals(): Observable<MessageEvent> {
    return this.amppControl.webRtcSignalEvents().pipe(
      map((event) => ({
        data: event,
      })),
    );
  }



}
