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

  @Prop({ type: Date, default: null })
  assignedAt: Date | null;

  @Prop({ type: Date, default: null })
  pickedUpAt: Date | null;

  @Prop({ type: Date, default: null })
  deliveredAt: Date | null;

  @Prop({ type: Date, default: null })
  estimatedDeliveryTime: Date | null;
}

export type DeliveryDocument = HydratedDocument<Delivery>;
export const DeliverySchema = SchemaFactory.createForClass(Delivery);
