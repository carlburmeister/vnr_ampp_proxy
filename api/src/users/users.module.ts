// import { Module } from '@nestjs/common';

// import { AmppControlClientModule } from '../ampp/ampp-control-client.module';
// import { UserCredentialsRepository } from './services/user-credentials.repository';

// @Module({
//   imports: [AmppControlClientModule],
//   providers: [UserCredentialsRepository],
//   exports: [UserCredentialsRepository],
// })
// export class UsersModule {}

import { Module } from '@nestjs/common';

import { AmppControlClientModule } from '../ampp/ampp-control-client.module';
import { ClientPermissionsService } from './services/client-permissions.service';
import { GvuiPermissionsService } from '../ampp-proxy/gvui/gvui-permissions.service';

import { UserCredentialsRepository } from './services/user-credentials.repository';

@Module({
  imports: [AmppControlClientModule],
  providers: [UserCredentialsRepository, ClientPermissionsService, GvuiPermissionsService],
  exports: [UserCredentialsRepository, ClientPermissionsService, GvuiPermissionsService],
})
export class UsersModule {}
