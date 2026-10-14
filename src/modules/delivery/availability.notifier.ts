import { Injectable } from '@nestjs/common';
import { DeliveryGateway } from './delivery.gateway';
import { DeliveryDocument } from './entities/delivery.schema';
import { PushService } from './push.service';

/** Fans a newly available delivery out to couriers (socket.io + push). */
@Injectable()
export class AvailabilityNotifier {
  constructor(
    private readonly gateway: DeliveryGateway,
    private readonly push: PushService,
  ) {}

  async notifyNewDelivery(delivery: DeliveryDocument): Promise<void> {
    this.gateway.emitAvailable(delivery);
    await this.push.notifyNewDelivery(delivery);
  }
}
