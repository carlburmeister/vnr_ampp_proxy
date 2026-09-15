import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { AmppApiProxyController } from './ampp-api-proxy.controller';
import { AmppBearerTokenService } from './ampp-bearer-token.service';
import { AmppBrowserSecurityService } from './ampp-browser-security.service';
import { AmppCookieHttpService } from './ampp-cookie-http.service';
import { AmppMatrixFilterService } from './ampp-matrix-filter.service';
import { AmppProxyController } from './ampp-proxy.controller';
import { AmppProxyPolicyService } from './ampp-proxy-policy.service';
import { AmppResponseRewriterService } from './ampp-response-rewriter.service';
import { AmppProxyService } from './ampp-proxy.service';
import { AmppProxySessionService } from './ampp-proxy-session.service';
import { AmppSessionBrokerService } from './ampp-session-broker.service';
import { AmppUtilityLoginService } from './ampp-utility-login.service';
import { AmppWebSocketProxyService } from './ampp-websocket-proxy.service';

@Module({
  imports: [AuthModule],
  controllers: [AmppProxyController, AmppApiProxyController],
  providers: [
    AmppBearerTokenService,
    AmppBrowserSecurityService,
    AmppCookieHttpService,
    AmppMatrixFilterService,
    AmppProxyPolicyService,
    AmppResponseRewriterService,
    AmppProxyService,
    AmppProxySessionService,
    AmppSessionBrokerService,
    AmppUtilityLoginService,
    AmppWebSocketProxyService,
  ],
  exports: [AmppWebSocketProxyService],
})
export class AmppProxyModule {}
