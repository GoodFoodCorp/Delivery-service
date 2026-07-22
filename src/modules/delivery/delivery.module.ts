import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DeliveryController } from './delivery.controller';
import { DeliveryGateway } from './delivery.gateway';
import { DELIVERY_REPOSITORY, MongooseDeliveryRepository } from './delivery.repository';
import { DeliveryService } from './delivery.service';
import { OrdersClient } from './orders.client';
import { Delivery, DeliverySchema } from './entities/delivery.schema';
import { PositionUpdate, PositionUpdateSchema } from './entities/position-update.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Delivery.name, schema: DeliverySchema },
      { name: PositionUpdate.name, schema: PositionUpdateSchema },
    ]),
  ],
  controllers: [DeliveryController],
  providers: [
    DeliveryService,
    DeliveryGateway,
    OrdersClient,
    { provide: DELIVERY_REPOSITORY, useClass: MongooseDeliveryRepository },
  ],
})
export class DeliveryModule {}
