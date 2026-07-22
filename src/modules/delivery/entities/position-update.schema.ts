import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * High-write-volume collection of courier GPS points.
 * TTL index keeps only the last 24h of history (POC retention).
 */
@Schema({ collection: 'position_updates' })
export class PositionUpdate {
  @Prop({ required: true, index: true })
  deliveryId: string;

  @Prop({ required: true })
  lat: number;

  @Prop({ required: true })
  lng: number;

  @Prop({ required: true, type: Date, expires: 86400 })
  timestamp: Date;
}

export type PositionUpdateDocument = HydratedDocument<PositionUpdate>;
export const PositionUpdateSchema = SchemaFactory.createForClass(PositionUpdate);
