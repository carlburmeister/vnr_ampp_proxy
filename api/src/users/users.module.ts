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

import { UserCredentialsRepository } from './services/user-credentials.repository';

@Module({
  providers: [UserCredentialsRepository],
  exports: [UserCredentialsRepository],
})
export class UsersModule {}