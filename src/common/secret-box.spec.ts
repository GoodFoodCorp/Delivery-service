import { randomBytes } from 'node:crypto';
import { open, seal } from './secret-box';

describe('secret-box', () => {
  const original = process.env.IBAN_ENCRYPTION_KEY;
  afterEach(() => {
    process.env.IBAN_ENCRYPTION_KEY = original;
  });

  it('round-trips and never stores the plain value', () => {
    process.env.IBAN_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    const sealed = seal('FR7630006000011234567890189');

    expect(sealed).not.toContain('FR76');
    expect(sealed).not.toBe(seal('FR7630006000011234567890189')); // random IV
    expect(open(sealed)).toBe('FR7630006000011234567890189');
  });

  it('reads values stored before encryption existed', () => {
    process.env.IBAN_ENCRYPTION_KEY = randomBytes(32).toString('hex');
    expect(open('FR7630006000011234567890189')).toBe('FR7630006000011234567890189');
  });

  it('detects tampering', () => {
    process.env.IBAN_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    const sealed = seal('FR7630006000011234567890189');
    const tampered = sealed.slice(0, -4) + (sealed.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect(() => open(tampered)).toThrow();
  });

  it('rejects a key of the wrong size', () => {
    process.env.IBAN_ENCRYPTION_KEY = 'c2hvcnQ=';
    expect(() => seal('x')).toThrow(/32 bytes/);
  });
});
