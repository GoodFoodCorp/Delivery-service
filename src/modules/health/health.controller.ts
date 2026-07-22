import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { DbService } from '../../core/db/db.service';

@ApiExcludeController()
@Controller()
export class HealthController {
  constructor(private readonly db: DbService) {}

  @Get('healthz')
  healthz() {
    return { status: 'ok' };
  }

  @Get('readyz')
  readyz() {
    if (!this.db.isConnected()) {
      throw new ServiceUnavailableException('mongodb unavailable');
    }
    return { status: 'ready' };
  }
}
