import { Body, Controller, Get, Patch, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentActor } from '../../common/decorators/current-actor.decorator';
import { Actor } from '../../common/auth.util';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CourierProfileInput, CourierProfileService } from './courier-profile.service';

@ApiTags('courier-profile')
@ApiBearerAuth()
@Controller('api/courier-profile')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('livreur', 'user')
export class CourierProfileController {
  constructor(private readonly profiles: CourierProfileService) {}

  @Get()
  get(@CurrentActor() actor: Actor) {
    return this.profiles.get(actor.userId);
  }

  @Put()
  apply(@CurrentActor() actor: Actor, @Body() body: CourierProfileInput) {
    return this.profiles.apply(actor.userId, body);
  }

  @Patch('availability')
  availability(@CurrentActor() actor: Actor, @Body() body: { isAvailable: boolean }) {
    return this.profiles.setAvailability(actor.userId, body.isAvailable);
  }

  @Put('push-token')
  pushToken(@CurrentActor() actor: Actor, @Body() body: { pushToken: string }) {
    return this.profiles.setPushToken(actor.userId, body.pushToken);
  }

  @Get('earnings')
  earnings(@CurrentActor() actor: Actor) {
    return this.profiles.earnings(actor.userId);
  }
}
