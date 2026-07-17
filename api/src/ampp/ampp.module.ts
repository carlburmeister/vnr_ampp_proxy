import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { AmppControlClientModule } from './ampp-control-client.module';
import { AmppControlController } from './controllers/ampp-control.controller';
import { AmppSessionController } from './controllers/ampp-session.controller';
import { AmppKeyframesController } from './controllers/keyframes.controller';
import { KeyframesService } from './services/keyframes.service';

@Module({
  imports: [AuthModule, AmppControlClientModule],
  controllers: [
    AmppControlController,
    AmppKeyframesController,
    AmppSessionController,
  ],
  providers: [KeyframesService],
  exports: [AmppControlClientModule, KeyframesService],
})
export class AmppModule {}