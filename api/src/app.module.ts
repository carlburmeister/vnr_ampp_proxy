import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AppController } from './app.controller';
import { AppService } from './app.service';

import { AmppModule } from './ampp/ampp.module';
import { AmppProxyModule } from './ampp-proxy/ampp-proxy.module';
import { AuthModule } from './auth/auth.module';

function validateConfig(config: Record<string, unknown>) {
  const platformUrl = config.PLATFORM_URL;

  if (typeof platformUrl !== 'string') {
    throw new Error('PLATFORM_URL must be set');
  }

  if (new URL(platformUrl).protocol !== 'https:') {
    throw new Error('PLATFORM_URL must use HTTPS');
  }

  return config;
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateConfig,
    }),
    AuthModule,
    AmppModule,
    AmppProxyModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
