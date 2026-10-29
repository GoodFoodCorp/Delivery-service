import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export enum DeliveryStatus {
  Unassigned = 'UNASSIGNED',
  Assigned = 'ASSIGNED',
  PickedUp = 'PICKED_UP',
  InTransit = 'IN_TRANSIT',
  Delivered = 'DELIVERED',
  Cancelled = 'CANCELLED',
}

/** Statuses during which a courier runs the delivery. */
export const ACTIVE_STATUSES = [DeliveryStatus.Assigned, DeliveryStatus.PickedUp, DeliveryStatus.InTransit];

@Schema({ _id: false })
export class GeoPoint {
  @Prop({ required: true })
  address: string;

  @Prop({ required: true })
  lat: number;

  @Prop({ required: true })
  lng: number;
}

const GeoPointSchema = SchemaFactory.createForClass(GeoPoint);

/** GeoJSON point, for MongoDB's 2dsphere queries (longitude first). */
@Schema({ _id: false })
export class GeoJsonPoint {
  @Prop({ type: String, enum: ['Point'], default: 'Point' })
  type: 'Point';

  @Prop({ type: [Number], required: true })
  coordinates: [number, number];
}

const GeoJsonPointSchema = SchemaFactory.createForClass(GeoJsonPoint);

export function toGeoJson(p: { lat: number; lng: number }): GeoJsonPoint {
  return { type: 'Point', coordinates: [p.lng, p.lat] };
}

@Schema({ collection: 'deliveries', timestamps: true })
export class Delivery {
  /** Order id in order-service (uuid) — one delivery per order. */
  @Prop({ required: true, unique: true, index: true })
  orderId: string;

  /** Customer who placed the order (for tracking access control). */
  @Prop({ required: true, index: true })
  customerId: string;

  /** Restaurant tenant id (manager access control). */
  @Prop({ required: true })
  restaurantId: string;

  /** Assigned courier user id — null until a courier accepts. */
  @Prop({ type: String, default: null, index: true })
  livreurId: string | null;

  @Prop({ required: true, enum: DeliveryStatus, default: DeliveryStatus.Unassigned, index: true })
  status: DeliveryStatus;

  @Prop({ type: GeoPointSchema, required: true })
  pickup: GeoPoint;

  @Prop({ type: GeoPointSchema, required: true })
  dropoff: GeoPoint;

  /** Pickup point for "deliveries around me" queries (2dsphere index). */
  @Prop({ type: GeoJsonPointSchema, default: null })
  pickupLocation: GeoJsonPoint | null;

  /** True when a position could not be resolved and was estimated. */
  @Prop({ default: false })
  locationApproximate: boolean;

  @Prop({ type: Date, default: null })
  assignedAt: Date | null;

  @Prop({ type: Date, default: null })
  pickedUpAt: Date | null;

  @Prop({ type: Date, default: null })
  deliveredAt: Date | null;

  @Prop({ type: Date, default: null })
  cancelledAt: Date | null;

  @Prop({ type: Date, default: null })
  estimatedDeliveryTime: Date | null;

  /** Courier pay for this delivery, in cents. Null on deliveries created before fees existed. */
  @Prop({ type: Number, default: null })
  courierFeeCents: number | null;

  /** Tip left by the customer, entirely for the courier. */
  @Prop({ type: Number, default: 0 })
  tipCents: number;

  /** 4-digit code the customer gives the courier at the door: proof of
   *  delivery. Only the customer can read it. */
  @Prop({ type: String, default: null, select: false })
  handoverCode: string | null;

  @Prop({ type: Number, default: 0 })
  handoverAttempts: number;

  /** Customer's rating of the delivery, 1 to 5. */
  @Prop({ type: Number, default: null, min: 1, max: 5 })
  rating: number | null;

  @Prop({ type: String, default: '' })
  ratingComment: string;

  @Prop({ type: Date, default: null })
  ratedAt: Date | null;
}

export type DeliveryDocument = HydratedDocument<Delivery>;
export const DeliverySchema = SchemaFactory.createForClass(Delivery);
DeliverySchema.index({ pickupLocation: '2dsphere' }, { sparse: true });
DeliverySchema.index({ livreurId: 1, status: 1, deliveredAt: -1 });
