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
import { SessionAuthGuard } from './session-auth.guard';
import { MysqlSessionStore } from './mysql-session.store';
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
    await store.create(req.sessionID, req.session);

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
  //  logout()
  /*-------------------------------------------------------------*/ 
  @Post('logout')
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
