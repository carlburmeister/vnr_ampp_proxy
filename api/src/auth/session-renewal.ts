import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { SSE_METADATA } from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request, RequestHandler, Response } from 'express';
import { catchError, concatMap, from, throwError, type Observable } from 'rxjs';
import { MysqlSessionStore, SessionExpiredError } from './mysql-session.store';
import {
  PersistSessionInController,
  rejectExpiredSession,
} from './session-auth.guard';

@Injectable()
export class SessionRenewalInterceptor implements NestInterceptor {
  constructor(
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    if (context.getType() === 'http') {
      const http = context.switchToHttp();
      const req = http.getRequest<Request>();
      const res = http.getResponse<Response>();
      const store = req.sessionStore;
      if (
        req.session?.user &&
        !res.destroyed &&
        store instanceof MysqlSessionStore &&
        store.touchIntervalMs > 0 &&
        !this.reflector.get(PersistSessionInController, context.getHandler())
      ) {
        try {
          // Validate/renew before a handler can send JSON or streaming headers.
          await renewSessionForResponse(req);
        } catch (error) {
          if (error instanceof SessionExpiredError) {
            return rejectExpiredSession(req, res, this.config);
          }
          throw error;
        }
        let result = next.handle() as Observable<unknown>;
        if (!this.reflector.get<boolean>(SSE_METADATA, context.getHandler())) {
          result = result.pipe(
            concatMap(async (value: unknown) => {
              // A slow non-streaming handler may cross the renewal boundary.
              if (!res.headersSent && !res.destroyed)
                await renewSessionForResponse(req);
              return value;
            }),
          );
        }
        return result.pipe(
          catchError((error: unknown) =>
            error instanceof SessionExpiredError &&
            !res.headersSent &&
            !res.destroyed
              ? from(rejectExpiredSession(req, res, this.config))
              : throwError(() => error),
          ),
        );
      }
    }
    return next.handle();
  }
}

export async function renewSessionForResponse(req: Request): Promise<void> {
  if (
    req.session?.user &&
    req.sessionStore instanceof MysqlSessionStore &&
    req.sessionStore.touchIntervalMs > 0
  ) {
    await req.sessionStore.renewForResponse(req.sessionID, req.session);
  }
}

export function withConfirmedSessionCookies(
  middleware: RequestHandler,
  store: MysqlSessionStore,
  cookieName: string,
): RequestHandler {
  if (store.touchIntervalMs === 0) return middleware;
  return (req, res, next) => {
    const setHeader = res.setHeader.bind(res) as Response['setHeader'];
    res.setHeader = function (this: Response, name, value) {
      const deadline = store.confirmedExpiry(req.session);
      const clamp = (cookie: string): string => {
        if (!cookie.startsWith(`${cookieName}=`) || deadline === undefined)
          return cookie;
        return cookie.replace(
          /;\s*Expires=([^;]+)/i,
          (match: string, date: string) =>
            Date.parse(date) > deadline
              ? `; Expires=${new Date(deadline).toUTCString()}`
              : match,
        );
      };
      const bounded =
        name.toLowerCase() !== 'set-cookie'
          ? value
          : typeof value === 'string'
            ? clamp(value)
            : Array.isArray(value)
              ? (value as string[]).map(clamp)
              : value;
      // The signed value, flags, other cookies and native header timing remain.
      setHeader(name, bounded);
      return this;
    };
    middleware(req, res, next);
  };
}
