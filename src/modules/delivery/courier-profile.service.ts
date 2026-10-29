import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  CourierProfile,
  CourierProfileDocument,
  CourierVehicleType,
} from './entities/courier-profile.schema';
import { isValidIban, normalizeIban } from './iban';

/** A position older than this is not used to target couriers. */
const LOCATION_FRESHNESS_MS = 30 * 60 * 1000;
const EARTH_RADIUS_KM = 6378.1;

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

  /**
   * Toggles the courier's online status. `canCreate` (true for accounts with the
   * livreur role) lets couriers created before courier profiles existed get a
   * minimal profile on first use instead of a 404; they can complete it later.
   */
  async setAvailability(userId: string, isAvailable: boolean, canCreate = false) {
    const profile = await this.profiles
      .findOneAndUpdate(
        { userId },
        canCreate ? { isAvailable, $setOnInsert: { siret: '', city: '', iban: '' } } : { isAvailable },
        canCreate ? { upsert: true, new: true, setDefaultsOnInsert: true } : { new: true },
      )
      .exec();
    if (!profile) throw new NotFoundException('Profil livreur introuvable');
    return this.toResponse(profile);
  }

  /** Courier payout IBAN. Like setAvailability, creates a minimal profile for livreur accounts without one. */
  async setIban(userId: string, iban: string, canCreate = false) {
    if (!isValidIban(iban)) throw new BadRequestException('IBAN invalide');
    const normalized = normalizeIban(iban);
    const profile = await this.profiles
      .findOneAndUpdate(
        { userId },
        canCreate ? { iban: normalized, $setOnInsert: { siret: '', city: '' } } : { iban: normalized },
        canCreate ? { upsert: true, new: true, setDefaultsOnInsert: true } : { new: true },
      )
      .exec();
    if (!profile) throw new NotFoundException('Profil livreur introuvable');
    return this.toResponse(profile);
  }

  /** Stored IBAN, or an empty string when the courier has none. */
  async getIban(userId: string): Promise<string> {
    const profile = await this.profiles.findOne({ userId }).select('+iban').lean().exec();
    return profile?.iban ?? '';
  }

  async setPushToken(userId: string, pushToken: string) {
    if (!/^Expo(nent)?PushToken\[.+\]$/.test(pushToken ?? '')) {
      throw new BadRequestException('Token push invalide');
    }
    const profile = await this.profiles.findOneAndUpdate({ userId }, { pushToken }, { new: true }).exec();
    if (!profile) throw new NotFoundException('Profil livreur introuvable');
    return { ok: true };
  }

  /** Records where the courier is, so new deliveries are offered to couriers nearby. */
  async setLocation(userId: string, lat: number, lng: number) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      throw new BadRequestException('Position invalide');
    }
    const profile = await this.profiles
      .findOneAndUpdate(
        { userId },
        { lastLocation: { type: 'Point', coordinates: [lng, lat] }, locatedAt: new Date() },
        { new: true },
      )
      .exec();
    if (!profile) throw new NotFoundException('Profil livreur introuvable');
    return { ok: true };
  }

  /**
   * Couriers who are online and can receive a push. With a pickup point, only
   * those seen within radiusKm of it recently — plus those whose position is
   * unknown, so a courier never misses everything because location is off.
   */
  async listPushTargets(
    near?: { lat: number; lng: number; radiusKm: number },
  ): Promise<{ userId: string; pushToken: string }[]> {
    const base = { isAvailable: true, pushToken: { $ne: null } };
    const select = (filter: object) => this.profiles.find(filter).select('+pushToken').lean().exec();
    let profiles: { userId: string; pushToken?: string | null }[];
    if (near) {
      const recent = new Date(Date.now() - LOCATION_FRESHNESS_MS);
      const [nearby, unlocated] = await Promise.all([
        select({
          ...base,
          locatedAt: { $gte: recent },
          lastLocation: { $geoWithin: { $centerSphere: [[near.lng, near.lat], near.radiusKm / EARTH_RADIUS_KM] } },
        }),
        select({ ...base, $or: [{ locatedAt: null }, { locatedAt: { $lt: recent } }] }),
      ]);
      profiles = [...nearby, ...unlocated];
    } else {
      profiles = await select(base);
    }
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
