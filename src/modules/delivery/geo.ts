/**
 * POC geo helpers — no paid geocoding API (see hypotheses): coordinates are
 * derived deterministically from ids around central Paris so the mobile map
 * has stable, plausible points. Swap for a real geocoder later.
 */
const PARIS = { lat: 48.8566, lng: 2.3522 };

function hashToUnit(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) | 0;
  }
  return (((h % 1000) + 1000) % 1000) / 1000; // [0, 1)
}

export function pseudoCoordinates(seed: string): { lat: number; lng: number } {
  // Spread points within ~±2.5 km of the city centre.
  const u = hashToUnit(seed);
  const v = hashToUnit(seed.split('').reverse().join(''));
  return {
    lat: Number((PARIS.lat + (u - 0.5) * 0.045).toFixed(6)),
    lng: Number((PARIS.lng + (v - 0.5) * 0.065).toFixed(6)),
  };
}

/** Haversine distance in kilometres. */
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Straight-line ETA at an average urban courier speed of 20 km/h. */
export function estimateDeliveryTime(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
): Date {
  const hours = distanceKm(from, to) / 20;
  return new Date(Date.now() + Math.max(hours, 0.05) * 3600 * 1000);
}

const DEFAULT_FEE_BASE_CENTS = 300;
const DEFAULT_FEE_PER_KM_CENTS = 60;

function envCents(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Courier pay for one delivery: base fee + per-km rate over the straight-line
 * pickup → dropoff distance, rounded to the cent. Tariff is configurable via
 * COURIER_FEE_BASE_CENTS / COURIER_FEE_PER_KM_CENTS (default 3.00 EUR + 0.60 EUR/km).
 */
export function computeCourierFeeCents(
  pickup: { lat: number; lng: number },
  dropoff: { lat: number; lng: number },
): number {
  const base = envCents('COURIER_FEE_BASE_CENTS', DEFAULT_FEE_BASE_CENTS);
  const perKm = envCents('COURIER_FEE_PER_KM_CENTS', DEFAULT_FEE_PER_KM_CENTS);
  return Math.round(base + perKm * distanceKm(pickup, dropoff));
}

/** Average urban speed per vehicle, km/h (traffic lights, parking included). */
const SPEED_KMH: Record<string, number> = { bike: 15, ebike: 20, scooter: 25, car: 22 };
const DEFAULT_SPEED_KMH = 18;
/** Streets are longer than the straight line between two points. */
const ROAD_FACTOR = 1.3;
/** Minutes to collect the bag at the restaurant, then to hand it over. */
export const PICKUP_MINUTES = 3;
export const HANDOVER_MINUTES = 2;

export interface LiveEta {
  etaAt: Date;
  /** Road distance still to cover, km. */
  remainingKm: number;
  phase: 'TO_RESTAURANT' | 'TO_CUSTOMER';
}

/**
 * Arrival time from the courier's current position: to the restaurant and
 * then to the customer before the pickup, straight to the customer after.
 */
export function liveEta(
  position: { lat: number; lng: number },
  pickup: { lat: number; lng: number },
  dropoff: { lat: number; lng: number },
  pickedUp: boolean,
  vehicle?: string | null,
  now = new Date(),
): LiveEta {
  const speed = (vehicle && SPEED_KMH[vehicle]) || DEFAULT_SPEED_KMH;
  const straight = pickedUp
    ? distanceKm(position, dropoff)
    : distanceKm(position, pickup) + distanceKm(pickup, dropoff);
  const remainingKm = straight * ROAD_FACTOR;
  const minutes = (remainingKm / speed) * 60 + HANDOVER_MINUTES + (pickedUp ? 0 : PICKUP_MINUTES);
  return {
    etaAt: new Date(now.getTime() + minutes * 60_000),
    remainingKm: Math.round(remainingKm * 10) / 10,
    phase: pickedUp ? 'TO_CUSTOMER' : 'TO_RESTAURANT',
  };
}
