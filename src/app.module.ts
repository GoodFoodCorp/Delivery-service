import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { RequestIdInterceptor } from './common/interceptors/request-id.interceptor';
import { ConfigModule } from './core/config/config.module';
import { DbModule } from './core/db/db.module';
import { DeliveryModule } from './modules/delivery/delivery.module';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        base: { service: 'delivery-service' },
        genReqId: (req, res) => {
          const id = (req.headers['x-request-id'] as string) ?? randomUUID();
          res.setHeader('X-Request-ID', id);
          return id;
        },
        autoLogging: { ignore: (req) => req.url === '/healthz' || req.url === '/readyz' },
      },
    }),
    DbModule,
    DeliveryModule,
    HealthModule,
  ],
  providers: [{ provide: APP_INTERCEPTOR, useClass: RequestIdInterceptor }],
})
export class AppModule {}
