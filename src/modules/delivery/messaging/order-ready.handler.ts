import { Injectable, Logger } from '@nestjs/common';
import { AvailabilityNotifier } from '../availability.notifier';
import { DeliveryService } from '../delivery.service';
import { parseOrderReadyEvent } from './order-ready.event';

/** Transport-agnostic processing of an order.ready_for_pickup message. */
@Injectable()
export class OrderReadyHandler {
  private readonly logger = new Logger(OrderReadyHandler.name);

  constructor(
    private readonly deliveries: DeliveryService,
    private readonly notifier: AvailabilityNotifier,
  ) {}

  /** Throws when the message is invalid or the delivery cannot be stored. */
  async handle(raw: Buffer): Promise<void> {
    const order = parseOrderReadyEvent(raw);
    const { delivery, created } = await this.deliveries.registerReadyOrder(order);
    if (!created) {
      this.logger.log(`order ${order.id} already has a delivery, ignoring redelivered event`);
      return;
    }
    try {
      await this.notifier.notifyNewDelivery(delivery);
    } catch (err) {
      // Notification is best-effort: the delivery exists and is listable.
      this.logger.warn(`could not notify couriers for order ${order.id}: ${(err as Error).message}`);
    }
  }
}
