import { Controller, Get, Headers, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Actor } from '../../common/auth.util';
import { CurrentActor } from '../../common/decorators/current-actor.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { DomainError } from '../../common/errors';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { NearQuery } from './delivery.repository';
import { DeliveryService } from './delivery.service';
import { WithdrawalService } from './withdrawal.service';

const DEFAULT_RADIUS_KM = 5;
const MAX_RADIUS_KM = 30;

/** Thin HTTP layer: no business logic, delegates to DeliveryService. */
@ApiTags('deliveries')
@ApiBearerAuth()
@Controller('api/deliveries')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DeliveryController {
  constructor(
    private readonly deliveries: DeliveryService,
    private readonly withdrawals: WithdrawalService,
  ) {}

  @Get('available')
  @Roles('livreur', 'admin')
  @ApiOperation({ summary: 'Unassigned deliveries, closest first when lat/lng are given (no customer data)' })
  @ApiQuery({ name: 'lat', required: false })
  @ApiQuery({ name: 'lng', required: false })
  @ApiQuery({ name: 'radiusKm', required: false })
  listAvailable(
    @CurrentActor() actor: Actor,
    @Query('lat') lat?: string,
    @Query('lng') lng?: string,
    @Query('radiusKm') radiusKm?: string,
  ) {
    return this.deliveries.listAvailable(actor, parseNear(lat, lng, radiusKm));
  }

  @Get('mine')
  @Roles('livreur')
  @ApiOperation({ summary: 'Active deliveries assigned to the connected courier' })
  listMine(@CurrentActor() actor: Actor) {
    return this.deliveries.listMine(actor);
  }

  @Get('history')
  @Roles('livreur')
  @ApiOperation({ summary: 'Earnings, recent delivered trips, balance and withdrawals of the connected courier' })
  history(@CurrentActor() actor: Actor) {
    return this.withdrawals.overview(actor);
  }

  @Post(':id/accept')
  @Roles('livreur')
  @ApiOperation({ summary: 'Courier takes the delivery (atomic: one courier wins), even while the order is cooking' })
  accept(@CurrentActor() actor: Actor, @Param('id') id: string, @Headers('x-request-id') requestId?: string) {
    return this.deliveries.accept(actor, id, requestId);
  }

  @Post(':id/release')
  @Roles('livreur')
  @ApiOperation({ summary: 'Courier gives the delivery up before collecting it' })
  release(@CurrentActor() actor: Actor, @Param('id') id: string, @Headers('x-request-id') requestId?: string) {
    return this.deliveries.release(actor, id, requestId);
  }

  @Post(':id/pickup')
  @Roles('livreur')
  @ApiOperation({ summary: 'Order picked up at the restaurant (requires READY_FOR_PICKUP)' })
  pickup(@CurrentActor() actor: Actor, @Param('id') id: string, @Headers('x-request-id') requestId?: string) {
    return this.deliveries.pickup(actor, id, requestId);
  }

  @Post(':id/dropoff')
  @Roles('livreur')
  @ApiOperation({ summary: 'Order delivered to the customer (timestamped)' })
  dropoff(@CurrentActor() actor: Actor, @Param('id') id: string, @Headers('x-request-id') requestId?: string) {
    return this.deliveries.dropoff(actor, id, requestId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Delivery detail + last known position' })
  getById(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.deliveries.getById(actor, id);
  }
}

/** Optional courier position for "deliveries around me". */
export function parseNear(lat?: string, lng?: string, radiusKm?: string): NearQuery | null {
  if (lat === undefined && lng === undefined) return null;
  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln) || Math.abs(la) > 90 || Math.abs(ln) > 180) {
    throw DomainError.validation('lat and lng must be valid coordinates');
  }
  const r = radiusKm === undefined ? DEFAULT_RADIUS_KM : Number(radiusKm);
  if (!Number.isFinite(r) || r <= 0) {
    throw DomainError.validation('radiusKm must be positive');
  }
  return { lat: la, lng: ln, radiusKm: Math.min(r, MAX_RADIUS_KM) };
}
