// api/src/ampp/ampp-control-client.module.ts
import { Module } from '@nestjs/common';

import { AmppControlService } from './services/ampp-control.service';

@Module({
  providers: [AmppControlService],
  exports: [AmppControlService],
})
export class AmppControlClientModule {}