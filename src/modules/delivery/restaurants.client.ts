import { Injectable, Logger } from '@nestjs/common';

/** Where a courier collects the meal. */
export interface RestaurantLocation {
  name: string;
  address: string;
  lat: number | null;
  lng: number | null;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 3000;

/**
 * Reads restaurants from franchise-service's public API (address and GPS
 * position), with an in-process cache: restaurants change rarely and every
 * new delivery needs its pickup point.
 */
@Injectable()
export class RestaurantsClient {
  private readonly logger = new Logger(RestaurantsClient.name);
  private readonly cache = new Map<string, { value: RestaurantLocation; expiresAt: number }>();

  private get baseUrl(): string {
    return (process.env.FRANCHISE_SERVICE_URL ?? 'http://franchise-service:8089').replace(/\/+$/, '');
  }

  /** Null when franchise-service cannot tell (unknown restaurant or outage). */
  async get(restaurantId: string): Promise<RestaurantLocation | null> {
    const hit = this.cache.get(restaurantId);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    try {
      const res = await fetch(`${this.baseUrl}/api/restaurants/${encodeURIComponent(restaurantId)}`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        this.logger.warn(`franchise-service replied ${res.status} for restaurant ${restaurantId}`);
        return null;
      }
      const r = (await res.json()) as {
        name: string;
        address: string;
        city: string;
        latitude: number | null;
        longitude: number | null;
      };
      const value: RestaurantLocation = {
        name: r.name,
        address: [r.address, r.city].filter(Boolean).join(', ') || r.name,
        lat: r.latitude,
        lng: r.longitude,
      };
      this.cache.set(restaurantId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
      return value;
    } catch (err) {
      this.logger.warn(`franchise-service unreachable: ${(err as Error).message}`);
      return null;
    }
  }
}
