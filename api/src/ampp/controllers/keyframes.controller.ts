import {
  Controller,
  Get,
  MessageEvent,
  Param,
  Post,
  Query,
  Req,
  Res,
  Sse,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { map, Observable } from 'rxjs';

import { SessionAuthGuard } from '../../auth/session-auth.guard';
import { KeyframesService } from '../services/keyframes.service';

@Controller('ampp/keyframes')
@UseGuards(SessionAuthGuard)
export class AmppKeyframesController {
  constructor(private readonly keyframes: KeyframesService) {}

  @Post('producers/:producerName/listener')
  startKeyframesListener(
    @Param('producerName') producerName: string,
    @Req() req: Request,
  ) {
    return this.keyframes.startKeyframesListener(producerName, req.session);
  }

  @Get('producers/:producerName/latest')
  getLatestKeyframeForProducer(
    @Param('producerName') producerName: string,
    @Req() req: Request,
  ) {
    return this.keyframes.getLatestKeyframeForProducer(
      producerName,
      req.session,
    );
  }

  @Get('producers/:producerName/image/latest')
  async getLatestKeyframeImage(
    @Param('producerName') producerName: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const filePath = await this.keyframes.getLatestKeyframeImagePath(
      producerName,
      req.session,
    );

    return res.sendFile(filePath);
  }

  @Sse('stream')
  streamKeyframes(
    @Query('producerName') producerName: string | undefined,
    @Req() req: Request,
  ): Observable<MessageEvent> {
    return this.keyframes.keyframeEvents(producerName, req.session).pipe(
      map((event) => ({
        data: event,
      })),
    );
  }
}