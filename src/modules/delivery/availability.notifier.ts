import { Injectable, Optional } from '@nestjs/common';
import { DeliveryGateway } from './delivery.gateway';
import { DeliveryService } from './delivery.service';
import { DeliveryDocument } from './entities/delivery.schema';
import { PushService } from './push.service';
import { courierAssignedNotifications } from './messaging/order-notifications';
import { NotificationsService } from './notifications.service';

/** Fans delivery news out to couriers (socket.io + push). */
@Injectable()
export class AvailabilityNotifier {
  constructor(
    private readonly gateway: DeliveryGateway,
    private readonly push: PushService,
    private readonly deliveries: DeliveryService,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  async notifyNewDelivery(delivery: DeliveryDocument): Promise<void> {
    const view = this.deliveries.toAvailableView(delivery);
    this.gateway.emitAvailable(view);
    await this.notifications?.publish(
      { kind: 'couriers', id: 'all' },
      {
        id: `available:${view.id}`,
        title: 'Nouvelle course disponible',
        body: `${view.pickup.address} · ${String(view.distanceKm).replace('.', ',')} km · ${((view.courierFeeCents + view.tipCents) / 100).toFixed(2).replace('.', ',')} €`,
        orderId: view.orderId,
        status: 'AVAILABLE',
        link: '/courier',
        at: new Date().toISOString(),
      },
    );
    await this.push.notifyNewDelivery(delivery);
  }

  notifyCancelled(delivery: DeliveryDocument): void {
    this.gateway.emitCancelled(delivery);
  }

  notifyAssigned(delivery: DeliveryDocument): void {
    for (const { target, notification } of courierAssignedNotifications(
      delivery.orderId,
      delivery.customerId,
      delivery.restaurantId,
    )) {
      if (this.notifications) void this.notifications.publish(target, notification);
      else this.gateway.emitNotification(target, notification);
    }
  }
}
