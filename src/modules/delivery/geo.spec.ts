import { computeCourierFeeCents } from './geo';

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
