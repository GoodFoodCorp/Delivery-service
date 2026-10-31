import { Injectable, Logger } from '@nestjs/common';
import { distanceKm } from './geo';

export type LatLng = [number, number];

/** A road route: its points (lat, lng), length and riding time. */
export interface PlannedRoute {
  path: LatLng[];
  distanceKm: number;
  durationMin: number;
}

/** Plans a route on the roads through the given points, in order. */
export interface RoutePlanner {
  route(points: { lat: number; lng: number }[], vehicle: string | null): Promise<PlannedRoute | null>;
}

export const ROUTE_PLANNER = Symbol('ROUTE_PLANNER');

const ROUTING_TIMEOUT_MS = 3000;

/**
 * OSRM routing (the format of the open routing servers and of a self-hosted
 * OSRM). Two profiles: bike (bike, e-bike) and car (scooter, car).
 * ROUTING_BIKE_URL / ROUTING_CAR_URL point at them; the defaults are the
 * public FOSSGIS servers, fine for a demo, not for production volume: run
 * OSRM next to the service there. A failure answers null: the map then falls
 * back to a straight line and the arrival time to its estimate.
 */
@Injectable()
export class OsrmRoutePlanner implements RoutePlanner {
  private readonly logger = new Logger(OsrmRoutePlanner.name);
  private readonly bikeUrl = process.env.ROUTING_BIKE_URL ?? 'https://routing.openstreetmap.de/routed-bike';
  private readonly carUrl = process.env.ROUTING_CAR_URL ?? 'https://routing.openstreetmap.de/routed-car';

  async route(points: { lat: number; lng: number }[], vehicle: string | null): Promise<PlannedRoute | null> {
    if (process.env.ROUTING_DISABLED === 'true' || points.length < 2) return null;
    const base = vehicle === 'scooter' || vehicle === 'car' ? this.carUrl : this.bikeUrl;
    const coords = points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
    const url = `${base.replace(/\/$/, '')}/route/v1/driving/${coords}?overview=full&geometries=geojson`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(ROUTING_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`routing returned ${res.status}`);
      const body = (await res.json()) as {
        code?: string;
        routes?: { distance: number; duration: number; geometry: { coordinates: [number, number][] } }[];
      };
      const best = body.routes?.[0];
      if (body.code !== 'Ok' || !best) return null;
      return {
        path: best.geometry.coordinates.map(([lng, lat]) => [lat, lng] as LatLng),
        distanceKm: best.distance / 1000,
        durationMin: best.duration / 60,
      };
    } catch (err) {
      this.logger.warn(`routing unavailable: ${(err as Error).message}`);
      return null;
    }
  }
}

/** Where along a route a position is: the nearest point, and how far off. */
export function locateOnRoute(
  path: LatLng[],
  at: { lat: number; lng: number },
): { index: number; offKm: number } {
  let index = 0;
  let offKm = Infinity;
  path.forEach(([lat, lng], i) => {
    const d = distanceKm(at, { lat, lng });
    if (d < offKm) {
      offKm = d;
      index = i;
    }
  });
  return { index, offKm };
}

/** Length of a path from a point to its end, km. */
export function remainingKm(path: LatLng[], from: number): number {
  let km = 0;
  for (let i = from; i < path.length - 1; i++) {
    km += distanceKm({ lat: path[i][0], lng: path[i][1] }, { lat: path[i + 1][0], lng: path[i + 1][1] });
  }
  return km;
}
