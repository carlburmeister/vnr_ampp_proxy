import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';

import { LoginDto } from './dto/login.dto';
import { AuthService } from './auth.service';
import {
  PersistSessionInController,
  SessionAuthGuard,
  rejectExpiredSession,
} from './session-auth.guard';
import { MysqlSessionStore, SessionExpiredError } from './mysql-session.store';
import { clearSessionCookie } from './session-cookie';

@Controller('auth')
export class AuthController {
  
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  /*-------------------------------------------------------------*/
  //  login()
  /*-------------------------------------------------------------*/ 
  @Post('login')
  // Fresh login must not depend on the validity of its previous session row.
  @PersistSessionInController(true)
  async login(@Req() req: Request, @Body() body: LoginDto) {
    
    const result = await this.auth.login(body.username, body.password);

    // Prevent session fixation: issue a fresh server-side session ID after
    // credentials are validated, then store trusted server-side data in it.
    await new Promise<void>((resolve, reject) => {
      req.session.regenerate((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    this.auth.applyAuthorization(req.session, result);

    // Only a successful login may create a row. Ordinary saves must never
    // recreate a session removed by logout, revocation, or expiry.
    const store = req.sessionStore;
    if (!(store instanceof MysqlSessionStore))
      throw new Error('Login requires MysqlSessionStore');
    await store.create(req.sessionID, req.session, req.ip ?? null);

    await new Promise<void>((resolve, reject) => {
      req.session.save((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    // Do not return a token. The browser receives only an HttpOnly cookie.
    return { user: result.user };
  }
  /*-------------------------------------------------------------*/
  //  me()
  /*-------------------------------------------------------------*/ 
  @Get('me')
  @UseGuards(SessionAuthGuard)
  me(@Req() req: Request) {
    if (!req.session.user) {
      throw new UnauthorizedException('Login required');
    }

    return { user: req.session.user };
  }
  /*-------------------------------------------------------------*/
  //  activity()
  /*-------------------------------------------------------------*/
  @Post('activity')
  @UseGuards(SessionAuthGuard)
  @HttpCode(204)
  async activity(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    if (!(req.sessionStore instanceof MysqlSessionStore))
      throw new Error('Session activity requires MysqlSessionStore');
    try {
      await req.sessionStore.recordActivity(req.sessionID, req.session);
    } catch (error) {
      if (!(error instanceof SessionExpiredError)) throw error;
      return rejectExpiredSession(req, res, this.config);
    }
  }
  /*-------------------------------------------------------------*/
  //  logout()
  /*-------------------------------------------------------------*/ 
  @Post('logout')
  // Sign-out owns deletion, including an already-revoked previous session.
  @PersistSessionInController(true)
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    
    await new Promise<void>((resolve, reject) => {
      req.session.destroy((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    clearSessionCookie(res, this.config);
  }
}
