import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const PREFIX = 'enc:v1:';
const ALGORITHM = 'aes-256-gcm';

/**
 * Encrypts sensitive values at rest (IBAN) with AES-256-GCM. The key comes
 * from IBAN_ENCRYPTION_KEY (32 bytes, base64 or hex). Values stored before
 * encryption existed are read back unchanged, and re-encrypted on their next
 * write.
 */
function key(): Buffer | null {
  const raw = process.env.IBAN_ENCRYPTION_KEY;
  if (!raw) return null;
  const decoded = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (decoded.length !== 32) {
    throw new Error('IBAN_ENCRYPTION_KEY must be 32 bytes (base64 or hex)');
  }
  return decoded;
}

/** Fails at startup in production when no key is configured. */
export function assertEncryptionConfigured(): void {
  if (process.env.NODE_ENV === 'production' && !process.env.IBAN_ENCRYPTION_KEY) {
    throw new Error('IBAN_ENCRYPTION_KEY is required in production');
  }
  key();
}

export function seal(plain: string): string {
  const k = key();
  if (!k || plain === '') return plain;
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, k, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return PREFIX + [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join(':');
}

export function open(stored: string): string {
  if (!stored?.startsWith(PREFIX)) return stored ?? '';
  const k = key();
  if (!k) throw new Error('IBAN_ENCRYPTION_KEY is required to read encrypted values');
  const [iv, tag, data] = stored.slice(PREFIX.length).split(':').map((p) => Buffer.from(p, 'base64'));
  const decipher = createDecipheriv(ALGORITHM, k, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
