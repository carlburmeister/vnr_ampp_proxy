import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from './auth.service';

@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    if (!request.session?.user) {
      throw new UnauthorizedException('Login required');
    }

    const changed = await this.auth.refreshSessionAuthorization(request.session);
    if (changed) {
      await new Promise<void>((resolve, reject) => {
        request.session.save((error) => error ? reject(error) : resolve());
      });
    }

    return true;
  }
}
