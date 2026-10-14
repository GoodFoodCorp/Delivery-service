import { Inject, Injectable, Logger } from '@nestjs/common';
import { CourierProfileService } from './courier-profile.service';
import { DELIVERY_REPOSITORY, DeliveryRepository } from './delivery.repository';
import { DeliveryDocument } from './entities/delivery.schema';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

interface ExpoTicket {
  status: 'ok' | 'error';
  details?: { error?: string };
}

/** Sends Expo push notifications to couriers who can take a new delivery. */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  constructor(
    private readonly profiles: CourierProfileService,
    @Inject(DELIVERY_REPOSITORY) private readonly repo: DeliveryRepository,
  ) {}

  async notifyNewDelivery(delivery: DeliveryDocument): Promise<void> {
    try {
      const [targets, busy] = await Promise.all([
        this.profiles.listPushTargets(),
        this.repo.listActiveCourierIds(),
      ]);
      const busyIds = new Set(busy);
      const eligible = targets.filter((t) => !busyIds.has(t.userId));
      if (eligible.length === 0) return;

      const messages = eligible.map((t) => ({
        to: t.pushToken,
        title: 'Nouvelle commande disponible',
        body: `Retrait : ${delivery.pickup.address}`,
        sound: 'default',
        channelId: 'default',
        data: { screen: 'delivery-home', deliveryId: String(delivery._id) },
      }));

      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(messages),
      });
      if (!res.ok) {
        this.logger.warn(`expo push replied ${res.status}`);
        return;
      }
      const { data } = (await res.json()) as { data: ExpoTicket[] };
      const invalid = data
        .map((ticket, i) => (ticket.details?.error === 'DeviceNotRegistered' ? messages[i].to : null))
        .filter((token): token is string => token !== null);
      await this.profiles.clearPushTokens(invalid);
    } catch (err) {
      this.logger.warn(`push notification failed: ${(err as Error).message}`);
    }
  }
}
