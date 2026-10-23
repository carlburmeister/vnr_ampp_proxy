import type { ConfigService } from '@nestjs/config';
import type { CookieOptions, Response } from 'express';

export const SESSION_MAX_AGE = 1000 * 60 * 60 * 8;

export function sessionCookieSettings(config: ConfigService) {
  return {
    name: config.get<string>('SESSION_COOKIE_NAME') ?? 'amvvpp.sid',
    cookie: {
      path: '/',
      httpOnly: true,
      secure: config.get<string>('NODE_ENV') === 'production',
      sameSite: 'lax',
    } satisfies CookieOptions,
  };
}

export function clearSessionCookie(response: Response, config: ConfigService) {
  const { name, cookie } = sessionCookieSettings(config);
  response.clearCookie(name, cookie);
}
