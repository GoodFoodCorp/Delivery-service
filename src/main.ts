import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { RedisIoAdapter } from './core/realtime/redis-io.adapter';
import { assertEncryptionConfigured } from './common/secret-box';
import { allowedOrigins } from './common/origins';

async function bootstrap(): Promise<void> {
  assertEncryptionConfigured();
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new GlobalExceptionFilter());
  // The web app calls through the gateway on its own origin: only the
  // origins configured on purpose get CORS with credentials.
  app.enableCors({ origin: allowedOrigins(), credentials: true });

  // Several replicas share Socket.IO rooms through Redis; one replica alone
  // works without it (development).
  const ioAdapter = new RedisIoAdapter(app);
  if (process.env.REDIS_URL) {
    await ioAdapter.connect(process.env.REDIS_URL);
  }
  app.useWebSocketAdapter(ioAdapter);
  app.enableShutdownHooks();

  const config = new DocumentBuilder()
    .setTitle('Delivery Service API')
    .setDescription('Good Food 3.0 — deliveries and real-time courier tracking (Socket.IO namespace /tracking).')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));

  const port = process.env.PORT ?? '8084';
  await app.listen(port);
  app.get(Logger).log(`delivery-service started on port ${port}`);
}

void bootstrap();
