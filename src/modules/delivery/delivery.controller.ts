import { Controller, Get, Headers, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Actor } from '../../common/auth.util';
import { CurrentActor } from '../../common/decorators/current-actor.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { DeliveryService } from './delivery.service';

/** Thin HTTP layer: no business logic, delegates to DeliveryService. */
@ApiTags('deliveries')
@ApiBearerAuth()
@Controller('api/deliveries')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DeliveryController {
  constructor(private readonly deliveries: DeliveryService) {}

  @Get('available')
  @Roles('livreur', 'admin')
  @ApiOperation({ summary: 'Unassigned deliveries (synced from order-service)' })
  listAvailable(@CurrentActor() actor: Actor, @Headers('x-request-id') requestId?: string) {
    return this.deliveries.listAvailable(actor, requestId);
  }

  @Get('mine')
  @Roles('livreur')
  @ApiOperation({ summary: 'Active deliveries assigned to the connected courier' })
  listMine(@CurrentActor() actor: Actor) {
    return this.deliveries.listMine(actor);
  }

  @Post(':id/accept')
  @Roles('livreur')
  @ApiOperation({ summary: 'Courier takes the delivery' })
  accept(@CurrentActor() actor: Actor, @Param('id') id: string, @Headers('x-request-id') requestId?: string) {
    return this.deliveries.accept(actor, id, requestId);
  }

  @Post(':id/pickup')
  @Roles('livreur')
  @ApiOperation({ summary: 'Order picked up at the restaurant' })
  pickup(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.deliveries.pickup(actor, id);
  }

  @Post(':id/dropoff')
  @Roles('livreur')
  @ApiOperation({ summary: 'Order delivered to the customer (timestamped)' })
  dropoff(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Headers('x-request-id') requestId?: string,
  ) {
    return this.deliveries.dropoff(actor, id, requestId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Delivery detail + last known position' })
  getById(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.deliveries.getById(actor, id);
  }
}
