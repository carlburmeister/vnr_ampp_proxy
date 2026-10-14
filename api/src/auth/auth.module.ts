import { Module } from '@nestjs/common';

import { AmppControlClientModule } from '../ampp/ampp-control-client.module';
import { UsersModule } from '../users/users.module';
import { ClientPermissionsController } from '../users/controllers/client-permissions.controller';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SessionAuthGuard } from './session-auth.guard';

@Module({
  imports: [UsersModule, AmppControlClientModule],
  controllers: [AuthController, ClientPermissionsController],
  providers: [AuthService, SessionAuthGuard],
  exports: [AuthService, SessionAuthGuard],
})
export class AuthModule {}