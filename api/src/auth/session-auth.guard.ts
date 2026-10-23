import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { SessionExpiredError } from './mysql-session.store';
import { clearSessionCookie } from './session-cookie';

export async function rejectExpiredSession(
  request: Request,
  response: Response,
  config: ConfigService,
): Promise<never> {
  response.setHeader('Cache-Control', 'no-store');
  if (request.session) {
    await new Promise<void>((resolve, reject) => {
      request.session.destroy((failure?: Error) =>
        failure ? reject(failure) : resolve(),
      );
    });
  }
  clearSessionCookie(response, config);
  throw new UnauthorizedException({
    code: 'SESSION_EXPIRED',
    message: 'Login required',
  });
}

@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();

    try {
      if (!request.session?.user) {
        throw new UnauthorizedException('Login required');
      }

      const changed = await this.auth.refreshSessionAuthorization(
        request.session,
      );
      if (changed) {
        request.session.touch();
        await new Promise<void>((resolve, reject) => {
          request.session.save((error?: Error) =>
            error ? reject(error) : resolve(),
          );
        });
      }
    } catch (error) {
      if (
        !(
          error instanceof UnauthorizedException ||
          error instanceof SessionExpiredError
        )
      )
        throw error;
      return rejectExpiredSession(request, response, this.config);
    }

    return true;
  }
}
