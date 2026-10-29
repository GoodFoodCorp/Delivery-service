import { Injectable, Logger } from '@nestjs/common';
import { AvailabilityNotifier } from '../availability.notifier';
import { DeliveryService } from '../delivery.service';
import { ORDER_CANCELLED_ROUTING_KEY, parseOrderEvent } from './order-ready.event';

/** Transport-agnostic processing of the order events this service reacts to. */
@Injectable()
export class OrderReadyHandler {
  private readonly logger = new Logger(OrderReadyHandler.name);

  constructor(
    private readonly deliveries: DeliveryService,
    private readonly notifier: AvailabilityNotifier,
  ) {}

  /** Throws when the message is invalid or the change cannot be stored. */
  async handle(raw: Buffer): Promise<void> {
    const event = parseOrderEvent(raw);
    if (event.type === ORDER_CANCELLED_ROUTING_KEY) {
      const cancelled = await this.deliveries.cancelForOrder(event.orderId);
      if (cancelled) {
        this.notifier.notifyCancelled(cancelled);
      }
      return;
    }

    const order = event.order;
    const { delivery, created } = await this.deliveries.registerReadyOrder(order);
    if (!created || !delivery) {
      this.logger.log(`order ${order.id} needs no new delivery (pickup or redelivered event)`);
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
