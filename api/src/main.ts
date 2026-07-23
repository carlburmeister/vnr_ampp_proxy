import './auth/types/session-data';

import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import session from 'express-session';

import { MysqlSessionStore } from './auth/mysql-session.store';

import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  app.setGlobalPrefix('/api');

  app.enableCors({
    origin: 'http://localhost:5173',
    credentials: true,
  });

  const isProduction = process.env.NODE_ENV === 'production';

  const sessionSecret = config.get<string>('SESSION_SECRET');

  if (!sessionSecret || sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be set and at least 32 characters long');
  }

  const sessionCookieName = config.get<string>('SESSION_COOKIE_NAME') ?? 'vnr.sid';
  const sessionStore = new MysqlSessionStore({
    host: config.get<string>('MYSQL_HOST'),
    port: Number(config.get<string>('MYSQL_PORT') ?? 3306),
    user: config.get<string>('MYSQL_USER'),
    password: config.get<string>('MYSQL_PASSWORD'),
    database: config.get<string>('MYSQL_DATABASE'),
  });

  app.use(
    session({
      store: sessionStore,
      name: sessionCookieName,
      secret: sessionSecret,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        secure: isProduction,
        sameSite: 'lax',
        maxAge: 1000 * 60 * 60 * 8,
      },
    }),
  );

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
    }),
  );

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
