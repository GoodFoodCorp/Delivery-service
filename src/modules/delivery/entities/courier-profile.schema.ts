import { Prop, Schema, SchemaFactory, raw } from '@nestjs/mongoose';
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

  /** Last position the courier app reported (GeoJSON, longitude first).
   *  Absent until the first report: an array default would store an empty,
   *  invalid point that the 2dsphere index rejects, failing every insert. */
  @Prop(raw({ type: { type: String, enum: ['Point'] }, coordinates: { type: [Number], default: undefined } }))
  lastLocation?: { type: 'Point'; coordinates: [number, number] };

  @Prop({ type: Date, default: null })
  locatedAt: Date | null;
}

export type CourierProfileDocument = HydratedDocument<CourierProfile>;
export const CourierProfileSchema = SchemaFactory.createForClass(CourierProfile);
CourierProfileSchema.index({ lastLocation: '2dsphere' }, { sparse: true });
