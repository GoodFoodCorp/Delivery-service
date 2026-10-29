import { Injectable } from '@nestjs/common';
import { DeliveryGateway } from './delivery.gateway';
import { DeliveryService } from './delivery.service';
import { DeliveryDocument } from './entities/delivery.schema';
import { PushService } from './push.service';

/** Fans delivery news out to couriers (socket.io + push). */
@Injectable()
export class AvailabilityNotifier {
  constructor(
    private readonly gateway: DeliveryGateway,
    private readonly push: PushService,
    private readonly deliveries: DeliveryService,
  ) {}

  async notifyNewDelivery(delivery: DeliveryDocument): Promise<void> {
    this.gateway.emitAvailable(this.deliveries.toAvailableView(delivery));
    await this.push.notifyNewDelivery(delivery);
  }

  notifyCancelled(delivery: DeliveryDocument): void {
    this.gateway.emitCancelled(delivery);
  }
}
