import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * A notification kept for whoever it was meant for — a person, a restaurant
 * (all its managers), a courier, or every courier (a new delivery) — so it is
 * still there after signing in again. Removed on expiresAt.
 */
@Schema({ collection: 'notifications' })
export class StoredNotification {
  @Prop({ required: true })
  targetKind: string;

  @Prop({ required: true })
  targetId: string;

  /** The notification's own id: the same news is stored once per target. */
  @Prop({ required: true })
  nid: string;

  @Prop({ required: true })
  title: string;

  @Prop({ required: true })
  body: string;

  @Prop()
  orderId?: string;

  @Prop()
  status?: string;

  @Prop({ required: true })
  link: string;

  @Prop({ required: true, type: Date })
  at: Date;

  @Prop({ required: true, type: Date, expires: 0 })
  expiresAt: Date;
}

export type StoredNotificationDocument = HydratedDocument<StoredNotification>;
export const StoredNotificationSchema = SchemaFactory.createForClass(StoredNotification);
StoredNotificationSchema.index({ targetKind: 1, targetId: 1, at: -1 });
StoredNotificationSchema.index({ targetKind: 1, targetId: 1, nid: 1 }, { unique: true });

/** Up to when a person has read their notifications (shared targets included). */
@Schema({ collection: 'notification_reads' })
export class NotificationRead {
  @Prop({ required: true, unique: true })
  userId: string;

  @Prop({ required: true, type: Date })
  lastReadAt: Date;
}

export type NotificationReadDocument = HydratedDocument<NotificationRead>;
export const NotificationReadSchema = SchemaFactory.createForClass(NotificationRead);
