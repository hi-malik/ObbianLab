import 'reflect-metadata';
import { ConsoleLogger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new ConsoleLogger({ json: true, colors: false });
  const app = await NestFactory.create(AppModule, { rawBody: true, logger });
  app.use((req: Request, res: Response, next: NextFunction) => {
    const incoming = String(req.header('x-request-id') ?? '');
    const requestId = /^[a-zA-Z0-9_-]{1,100}$/.test(incoming) ? incoming : randomUUID();
    req.headers['x-request-id'] = requestId;
    res.setHeader('x-request-id', requestId);
    const start = performance.now();
    res.on('finish', () => logger.log({ event: 'http.request', requestId, method: req.method,
      route: req.route?.path ?? 'unmatched', statusCode: res.statusCode, durationMs: Math.round(performance.now() - start) }, 'HTTP'));
    next();
  });
  app.use(helmet());
  app.enableShutdownHooks();
  app.useGlobalPipes(new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    stopAtFirstError: false,
  }));
  const allowedOrigins = (process.env.CORS_ORIGINS ?? 'http://localhost:3000').split(',');
  app.enableCors({ origin: allowedOrigins, credentials: true });
  await app.listen(Number(process.env.PORT ?? 3001), '0.0.0.0');
}

void bootstrap();
