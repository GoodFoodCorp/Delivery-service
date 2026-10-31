import { Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Actor } from '../../common/auth.util';
import { CurrentActor } from '../../common/decorators/current-actor.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { NotificationsService } from './notifications.service';

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('api/notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({
    summary:
      'Latest notifications of the signed-in person (customer, restaurant, courier), with what is unread',
  })
  list(@CurrentActor() actor: Actor) {
    return this.notifications.list(actor);
  }

  @Post('read')
  @HttpCode(204)
  @ApiOperation({ summary: 'Marks every notification read' })
  async markRead(@CurrentActor() actor: Actor) {
    await this.notifications.markRead(actor);
  }
}
