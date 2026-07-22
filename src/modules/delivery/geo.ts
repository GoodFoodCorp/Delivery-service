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
  return ((h % 1000) + 1000) % 1000 / 1000; // [0, 1)
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
export function estimateDeliveryTime(from: { lat: number; lng: number }, to: { lat: number; lng: number }): Date {
  const hours = distanceKm(from, to) / 20;
  return new Date(Date.now() + Math.max(hours, 0.05) * 3600 * 1000);
}
