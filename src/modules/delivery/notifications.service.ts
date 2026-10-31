import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Actor } from '../../common/auth.util';
import { DeliveryGateway } from './delivery.gateway';
import {
  NotificationRead,
  NotificationReadDocument,
  StoredNotification,
  StoredNotificationDocument,
} from './entities/notification.schema';
import { Notification, NotificationTarget } from './messaging/order-notifications';

const DAY_MS = 86_400_000;
/** Order news stays a month; "a new delivery is available" only a day. */
const KEEP_MS: Record<NotificationTarget['kind'], number> = {
  user: 30 * DAY_MS,
  restaurant: 30 * DAY_MS,
  courier: 30 * DAY_MS,
  couriers: DAY_MS,
};
const LIST_LIMIT = 50;

export interface NotificationView extends Notification {
  read: boolean;
}

/**
 * Sends a notification live and keeps it, so it can be read after signing
 * in again or on another device.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectModel(StoredNotification.name) private readonly notifications: Model<StoredNotificationDocument>,
    @InjectModel(NotificationRead.name) private readonly reads: Model<NotificationReadDocument>,
    private readonly gateway: DeliveryGateway,
  ) {}

  async publish(target: NotificationTarget, notification: Notification): Promise<void> {
    const at = new Date(notification.at);
    try {
      await this.notifications
        .updateOne(
          { targetKind: target.kind, targetId: target.id, nid: notification.id },
          {
            $setOnInsert: {
              title: notification.title,
              body: notification.body,
              orderId: notification.orderId,
              status: notification.status,
              link: notification.link,
              at,
              expiresAt: new Date(at.getTime() + KEEP_MS[target.kind]),
            },
          },
          { upsert: true },
        )
        .exec();
    } catch (err) {
      // Still sent live: only the history misses it.
      this.logger.warn(`notification not stored: ${(err as Error).message}`);
    }
    this.gateway.emitNotification(target, notification);
  }

  /** The latest notifications of the signed-in person, newest first. */
  async list(actor: Actor): Promise<{ items: NotificationView[]; unread: number }> {
    const [docs, read] = await Promise.all([
      this.notifications
        .find({ $or: targetsOf(actor).map((t) => ({ targetKind: t.kind, targetId: t.id })) })
        .sort({ at: -1 })
        .limit(LIST_LIMIT)
        .lean()
        .exec(),
      this.reads.findOne({ userId: actor.userId }).lean().exec(),
    ]);
    const readUntil = read?.lastReadAt?.getTime() ?? 0;
    const items = docs.map((d) => ({
      id: d.nid,
      title: d.title,
      body: d.body,
      orderId: d.orderId ?? '',
      status: d.status ?? '',
      link: d.link,
      at: d.at.toISOString(),
      read: d.at.getTime() <= readUntil,
    }));
    return { items, unread: items.filter((i) => !i.read).length };
  }

  async markRead(actor: Actor): Promise<void> {
    await this.reads
      .updateOne({ userId: actor.userId }, { $set: { lastReadAt: new Date() } }, { upsert: true })
      .exec();
  }
}

/** Whose notifications a person reads: their own, their restaurant's, the couriers'. */
export function targetsOf(actor: Actor): NotificationTarget[] {
  const targets: NotificationTarget[] = [{ kind: 'user', id: actor.userId }];
  if (actor.roles.includes('manager') && actor.tenantId)
    targets.push({ kind: 'restaurant', id: actor.tenantId });
  if (actor.roles.includes('livreur'))
    targets.push({ kind: 'courier', id: actor.userId }, { kind: 'couriers', id: 'all' });
  return targets;
}
