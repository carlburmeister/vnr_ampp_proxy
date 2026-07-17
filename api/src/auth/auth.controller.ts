import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { LoginDto } from './dto/login.dto';
import { AuthService } from './auth.service';

const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'vnr.sid';

@Controller('auth')
export class AuthController {
  
  constructor(private readonly auth: AuthService) {}

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

    req.session.user = result.user;
    req.session.parentWorkloadId = result.parentWorkloadId;
    req.session.fabricId = result.fabricId;
    req.session.nodeId = result.nodeId;
    req.session.allowedWorkloads = result.allowedWorkloads;

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

    res.clearCookie(SESSION_COOKIE_NAME);
  }
}
