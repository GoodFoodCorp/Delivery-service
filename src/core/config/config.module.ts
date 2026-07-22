import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { loadConfig } from './configuration';

/** Global configuration: loads .env and exposes the typed AppConfig token. */
export const APP_CONFIG = 'APP_CONFIG';

@Global()
@Module({
  imports: [NestConfigModule.forRoot({ isGlobal: true })],
  providers: [{ provide: APP_CONFIG, useFactory: loadConfig }],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
