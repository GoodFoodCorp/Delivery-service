import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DeliveryController } from './delivery.controller';
import { DeliveryGateway } from './delivery.gateway';
import { DELIVERY_REPOSITORY, MongooseDeliveryRepository } from './delivery.repository';
import { DeliveryService } from './delivery.service';
import { OrdersClient } from './orders.client';
import { Delivery, DeliverySchema } from './entities/delivery.schema';
import { PositionUpdate, PositionUpdateSchema } from './entities/position-update.schema';
import { CourierProfile, CourierProfileSchema } from './entities/courier-profile.schema';
import { CourierProfileController } from './courier-profile.controller';
import { CourierProfileService } from './courier-profile.service';
import { AvailabilityNotifier } from './availability.notifier';
import { PushService } from './push.service';
import { OrderReadyConsumer } from './messaging/order-ready.consumer';
import { OrderReadyHandler } from './messaging/order-ready.handler';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Delivery.name, schema: DeliverySchema },
      { name: PositionUpdate.name, schema: PositionUpdateSchema },
      { name: CourierProfile.name, schema: CourierProfileSchema },
    ]),
  ],
  controllers: [DeliveryController, CourierProfileController],
  providers: [
    DeliveryService,
    DeliveryGateway,
    OrdersClient,
    CourierProfileService,
    AvailabilityNotifier,
    PushService,
    OrderReadyHandler,
    OrderReadyConsumer,
    { provide: DELIVERY_REPOSITORY, useClass: MongooseDeliveryRepository },
  ],
})
export class DeliveryModule {}
