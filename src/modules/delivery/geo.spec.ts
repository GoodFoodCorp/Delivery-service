import { computeCourierFeeCents, liveEta } from './geo';

const paris = { lat: 48.8566, lng: 2.3522 };
// ~1 km north of `paris`
const oneKmNorth = { lat: 48.8566 + 1 / 111.19, lng: 2.3522 };

describe('computeCourierFeeCents', () => {
  afterEach(() => {
    delete process.env.COURIER_FEE_BASE_CENTS;
    delete process.env.COURIER_FEE_PER_KM_CENTS;
  });

  it('pays only the base fee when pickup and dropoff are the same point', () => {
    expect(computeCourierFeeCents(paris, paris)).toBe(300);
  });

  it('adds 0.60 EUR per km by default, rounded to the cent', () => {
    expect(computeCourierFeeCents(paris, oneKmNorth)).toBe(360);
  });

  it('reads the tariff from the environment', () => {
    process.env.COURIER_FEE_BASE_CENTS = '500';
    process.env.COURIER_FEE_PER_KM_CENTS = '100';
    expect(computeCourierFeeCents(paris, oneKmNorth)).toBe(600);
  });

  it('falls back to the default tariff when the environment is invalid', () => {
    process.env.COURIER_FEE_BASE_CENTS = 'abc';
    expect(computeCourierFeeCents(paris, paris)).toBe(300);
  });
});

describe('liveEta', () => {
  const restaurant = { lat: 48.85, lng: 2.35 };
  const customer = { lat: 48.86, lng: 2.36 };
  const now = new Date('2026-10-31T12:00:00Z');

  it('goes through the restaurant before the pickup', () => {
    const before = liveEta({ lat: 48.84, lng: 2.34 }, restaurant, customer, false, 'bike', now);
    const after = liveEta(restaurant, restaurant, customer, true, 'bike', now);
    expect(before.phase).toBe('TO_RESTAURANT');
    expect(after.phase).toBe('TO_CUSTOMER');
    expect(before.etaAt.getTime()).toBeGreaterThan(after.etaAt.getTime());
  });

  it('is faster on a scooter than on a bike', () => {
    const bike = liveEta(restaurant, restaurant, customer, true, 'bike', now);
    const scooter = liveEta(restaurant, restaurant, customer, true, 'scooter', now);
    expect(scooter.etaAt.getTime()).toBeLessThan(bike.etaAt.getTime());
  });

  it('still leaves time for the handover at the door', () => {
    const atTheDoor = liveEta(customer, restaurant, customer, true, null, now);
    expect(atTheDoor.etaAt.getTime() - now.getTime()).toBe(2 * 60_000);
  });
});
