import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  CourierProfile,
  CourierProfileDocument,
  CourierVehicleType,
} from './entities/courier-profile.schema';

export interface CourierProfileInput {
  vehicleType: CourierVehicleType;
  siret: string;
  city: string;
  iban: string;
  drivingLicenseNumber?: string;
  hasBagEquipped: boolean;
}

@Injectable()
export class CourierProfileService {
  constructor(@InjectModel(CourierProfile.name) private readonly profiles: Model<CourierProfileDocument>) {}

  async get(userId: string) {
    const profile = await this.profiles.findOne({ userId }).select('+iban').lean().exec();
    if (!profile) throw new NotFoundException('Profil livreur introuvable');
    return this.toResponse(profile);
  }

  async apply(userId: string, input: CourierProfileInput) {
    if (!/^\d{9}$/.test(input.siret)) throw new Error('Le SIRET doit contenir 9 chiffres');
    if (!input.city?.trim() || !input.iban?.trim()) throw new Error('La ville et l’IBAN sont obligatoires');
    if (!input.hasBagEquipped) throw new Error('Un sac isotherme est obligatoire');
    if (
      (input.vehicleType === CourierVehicleType.Car || input.vehicleType === CourierVehicleType.Scooter) &&
      !input.drivingLicenseNumber?.trim()
    ) {
      throw new Error('Le permis est obligatoire pour ce véhicule');
    }
    const profile = await this.profiles
      .findOneAndUpdate(
        { userId },
        { ...input, userId, city: input.city.trim(), iban: input.iban.trim().toUpperCase() },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .select('+iban')
      .exec();
    return this.toResponse(profile);
  }

  async setAvailability(userId: string, isAvailable: boolean) {
    const profile = await this.profiles.findOneAndUpdate({ userId }, { isAvailable }, { new: true }).exec();
    if (!profile) throw new NotFoundException('Profil livreur introuvable');
    return this.toResponse(profile);
  }

  async setPushToken(userId: string, pushToken: string) {
    if (!/^Expo(nent)?PushToken\[.+\]$/.test(pushToken ?? '')) {
      throw new BadRequestException('Token push invalide');
    }
    const profile = await this.profiles.findOneAndUpdate({ userId }, { pushToken }, { new: true }).exec();
    if (!profile) throw new NotFoundException('Profil livreur introuvable');
    return { ok: true };
  }

  /** Couriers who are online and can receive a push. */
  async listPushTargets(): Promise<{ userId: string; pushToken: string }[]> {
    const profiles = await this.profiles
      .find({ isAvailable: true, pushToken: { $ne: null } })
      .select('+pushToken')
      .lean()
      .exec();
    return profiles.map((p) => ({ userId: p.userId, pushToken: p.pushToken as string }));
  }

  async clearPushTokens(tokens: string[]): Promise<void> {
    if (tokens.length === 0) return;
    await this.profiles.updateMany({ pushToken: { $in: tokens } }, { pushToken: null }).exec();
  }

  async earnings(userId: string) {
    const profile = await this.profiles.findOne({ userId }).exec();
    if (!profile) throw new NotFoundException('Profil livreur introuvable');
    return {
      availableBalance: profile.availableBalanceCents / 100,
      totalEarned: profile.totalEarnedCents / 100,
      completedTrips: profile.completedTrips,
    };
  }

  private toResponse(profile: CourierProfileDocument | (CourierProfile & { _id: unknown }) | null) {
    if (!profile) throw new NotFoundException('Profil livreur introuvable');
    return {
      id: String(profile._id),
      userId: profile.userId,
      vehicleType: profile.vehicleType,
      siret: profile.siret,
      city: profile.city,
      hasBagEquipped: profile.hasBagEquipped,
      isAvailable: profile.isAvailable,
      availableBalance: profile.availableBalanceCents / 100,
      totalEarned: profile.totalEarnedCents / 100,
      completedTrips: profile.completedTrips,
    };
  }
}
