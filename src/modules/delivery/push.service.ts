import { Inject, Injectable, Logger } from '@nestjs/common';
import { CourierProfileService } from './courier-profile.service';
import { DELIVERY_REPOSITORY, DeliveryRepository } from './delivery.repository';
import { DeliveryDocument } from './entities/delivery.schema';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
/** Expo accepts at most 100 messages per request. */
const EXPO_BATCH = 100;
/** Couriers this far from the restaurant are not pushed a new delivery. */
const PUSH_RADIUS_KM = Number(process.env.PUSH_RADIUS_KM) || 8;

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

  /**
   * Pushes a new delivery to the available couriers near its restaurant who
   * are not already on a run, in batches of 100 (Expo's limit). Best-effort:
   * failures are logged, never thrown.
   */
  async notifyNewDelivery(delivery: DeliveryDocument): Promise<void> {
    try {
      const [targets, busy] = await Promise.all([
        this.profiles.listPushTargets({ lat: delivery.pickup.lat, lng: delivery.pickup.lng, radiusKm: PUSH_RADIUS_KM }),
        this.repo.listActiveCourierIds(),
      ]);
      const busyIds = new Set(busy);
      const messages = targets
        .filter((t) => !busyIds.has(t.userId))
        .map((t) => ({
          to: t.pushToken,
          title: 'Nouvelle commande disponible',
          body: `Retrait : ${delivery.pickup.address}`,
          sound: 'default',
          channelId: 'default',
          data: { screen: 'delivery-home', deliveryId: String(delivery._id) },
        }));

      const invalid: string[] = [];
      for (let i = 0; i < messages.length; i += EXPO_BATCH) {
        invalid.push(...(await this.send(messages.slice(i, i + EXPO_BATCH))));
      }
      await this.profiles.clearPushTokens(invalid);
    } catch (err) {
      this.logger.warn(`push notification failed: ${(err as Error).message}`);
    }
  }

  /** Sends one batch; returns the tokens Expo reports as no longer registered. */
  private async send(batch: { to: string }[]): Promise<string[]> {
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(batch),
    });
    if (!res.ok) {
      this.logger.warn(`expo push replied ${res.status}`);
      return [];
    }
    const { data } = (await res.json()) as { data: ExpoTicket[] };
    return data
      .map((ticket, i) => (ticket.details?.error === 'DeviceNotRegistered' ? batch[i].to : null))
      .filter((token): token is string => token !== null);
  }
}
