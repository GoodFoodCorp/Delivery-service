import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DeliveryController } from './delivery.controller';
import { DeliveryGateway } from './delivery.gateway';
import { DELIVERY_REPOSITORY, MongooseDeliveryRepository } from './delivery.repository';
import { DeliveryService } from './delivery.service';
import { OrdersClient } from './orders.client';
import { ReconcileJob } from './reconcile.job';
import { RestaurantsClient } from './restaurants.client';
import { Delivery, DeliverySchema } from './entities/delivery.schema';
import { PositionUpdate, PositionUpdateSchema } from './entities/position-update.schema';
import { CourierProfile, CourierProfileSchema } from './entities/courier-profile.schema';
import { CourierProfileController } from './courier-profile.controller';
import { CourierProfileService } from './courier-profile.service';
import { AvailabilityNotifier } from './availability.notifier';
import { PushService } from './push.service';
import { Withdrawal, WithdrawalSchema } from './entities/withdrawal.schema';
import { MongooseWithdrawalRepository, WITHDRAWAL_REPOSITORY } from './withdrawal.repository';
import { WithdrawalController } from './withdrawal.controller';
import { WithdrawalService } from './withdrawal.service';
import { OrderReadyConsumer } from './messaging/order-ready.consumer';
import { OrderReadyHandler } from './messaging/order-ready.handler';
import { OrderNotificationsConsumer } from './messaging/order-notifications.consumer';
import { OsrmRoutePlanner, ROUTE_PLANNER } from './routing';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import {
  NotificationRead,
  NotificationReadSchema,
  StoredNotification,
  StoredNotificationSchema,
} from './entities/notification.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Delivery.name, schema: DeliverySchema },
      { name: PositionUpdate.name, schema: PositionUpdateSchema },
      { name: CourierProfile.name, schema: CourierProfileSchema },
      { name: Withdrawal.name, schema: WithdrawalSchema },
      { name: StoredNotification.name, schema: StoredNotificationSchema },
      { name: NotificationRead.name, schema: NotificationReadSchema },
    ]),
  ],
  controllers: [DeliveryController, CourierProfileController, WithdrawalController, NotificationsController],
  providers: [
    DeliveryService,
    DeliveryGateway,
    OrdersClient,
    RestaurantsClient,
    ReconcileJob,
    CourierProfileService,
    AvailabilityNotifier,
    PushService,
    WithdrawalService,
    { provide: WITHDRAWAL_REPOSITORY, useClass: MongooseWithdrawalRepository },
    OrderReadyHandler,
    OrderReadyConsumer,
    { provide: DELIVERY_REPOSITORY, useClass: MongooseDeliveryRepository },
    { provide: 'VEHICLE_LOOKUP', useExisting: CourierProfileService },
    { provide: ROUTE_PLANNER, useClass: OsrmRoutePlanner },
    OrderNotificationsConsumer,
    NotificationsService,
  ],
})
export class DeliveryModule {}
