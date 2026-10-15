/** IBAN helpers (format + ISO 7064 mod 97-10 checksum). */

export function normalizeIban(iban: string): string {
  return String(iban ?? '').replace(/\s+/g, '').toUpperCase();
}

export function isValidIban(iban: string): boolean {
  const value = normalizeIban(iban);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(value)) return false;
  // Move the first 4 characters to the end, letters become 10..35, then mod 97 === 1.
  const rearranged = value.slice(4) + value.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const digits = /[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char;
    for (const d of digits) {
      remainder = (remainder * 10 + Number(d)) % 97;
    }
  }
  return remainder === 1;
}

/** "FR1420041010050500013M02606" -> "FR•• •••• 2606". */
export function maskIban(iban: string): string {
  const value = normalizeIban(iban);
  if (!value) return '';
  return `${value.slice(0, 2)}•• •••• ${value.slice(-4)}`;
}
