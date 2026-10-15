import { maskIban, normalizeIban, isValidIban } from './iban';

describe('iban helpers', () => {
  it('normalizes spaces and case', () => {
    expect(normalizeIban(' fr14 2004 1010 0505 0001 3m02 606 ')).toBe('FR1420041010050500013M02606');
  });

  it('accepts valid IBANs (checksum mod 97)', () => {
    expect(isValidIban('FR14 2004 1010 0505 0001 3M02 606')).toBe(true);
    expect(isValidIban('DE89370400440532013000')).toBe(true);
  });

  it('rejects a wrong checksum, wrong characters and empty values', () => {
    expect(isValidIban('FR14 2004 1010 0505 0001 3M02 607')).toBe(false);
    expect(isValidIban('FR14-2004-1010')).toBe(false);
    expect(isValidIban('')).toBe(false);
    expect(isValidIban(undefined as unknown as string)).toBe(false);
  });

  it('masks all but the country code and the last 4 characters', () => {
    expect(maskIban('FR1420041010050500013M02606')).toBe('FR•• •••• 2606');
  });

  it('returns an empty string when there is no IBAN', () => {
    expect(maskIban('')).toBe('');
  });
});
