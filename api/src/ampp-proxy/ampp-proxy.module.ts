import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { AmppProxyController } from './ampp-proxy.controller';
import { AmppProxyPolicyService } from './ampp-proxy-policy.service';
import { AmppProxyService } from './ampp-proxy.service';
import { AmppSessionBrokerService } from './ampp-session-broker.service';

@Module({
  imports: [AuthModule],
  controllers: [AmppProxyController],
  providers: [
    AmppProxyPolicyService,
    AmppProxyService,
    AmppSessionBrokerService,
  ],
})
export class AmppProxyModule {}
