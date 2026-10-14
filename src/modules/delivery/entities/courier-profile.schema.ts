import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export enum CourierVehicleType {
  Bike = 'bike',
  Ebike = 'ebike',
  Scooter = 'scooter',
  Car = 'car',
}

@Schema({ collection: 'courier_profiles', timestamps: true })
export class CourierProfile {
  @Prop({ required: true, unique: true, index: true })
  userId: string;

  @Prop({ required: true, enum: CourierVehicleType, default: CourierVehicleType.Bike })
  vehicleType: CourierVehicleType;

  @Prop({ required: true })
  siret: string;

  @Prop({ required: true })
  city: string;

  @Prop({ required: true, select: false })
  iban: string;

  @Prop({ default: '' })
  drivingLicenseNumber: string;

  @Prop({ default: false })
  hasBagEquipped: boolean;

  @Prop({ default: false })
  isAvailable: boolean;

  @Prop({ default: 0 })
  availableBalanceCents: number;

  @Prop({ default: 0 })
  totalEarnedCents: number;

  @Prop({ default: 0 })
  completedTrips: number;

  /** Expo push token of the courier's device. Never exposed in API responses. */
  @Prop({ type: String, default: null, select: false })
  pushToken: string | null;
}

export type CourierProfileDocument = HydratedDocument<CourierProfile>;
export const CourierProfileSchema = SchemaFactory.createForClass(CourierProfile);
