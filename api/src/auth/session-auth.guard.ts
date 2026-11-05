import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { AuthService } from './auth.service';
import { SessionExpiredError } from './mysql-session.store';
import { clearSessionCookie } from './session-cookie';
// TEMP AMPP trace: remove with diagnostics/ampp-proxy-trace.ts.
import { tracePhase } from '../ampp-proxy/diagnostics/ampp-proxy-trace';

export const PersistSessionInController = Reflector.createDecorator<boolean>();
const pendingAuthorizationSaves = new WeakSet<Request>();

export function hasPendingAuthorizationSave(request: Request): boolean {
  return pendingAuthorizationSaves.has(request);
}

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
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): Promise<boolean> {
    return tracePhase('authorization', () => this.authorize(context));
  }

  private async authorize(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();

    try {
      if (!request.session?.user) {
        throw new UnauthorizedException('Login required');
      }

      const changed = await tracePhase('authorization.refresh', () =>
        this.auth.refreshSessionAuthorization(request.session),
      );
      if (
        changed &&
        this.reflector.get(PersistSessionInController, context.getHandler())
      ) {
        // Only an explicitly marked controller owns this request's final save.
        pendingAuthorizationSaves.add(request);
      } else if (changed) {
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
