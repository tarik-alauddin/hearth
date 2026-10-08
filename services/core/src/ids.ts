import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32

/** A ULID: unique, and sortable by creation time (48-bit ms timestamp + 80 random bits). */
export function newId(now: Date = new Date()): string {
  let n = (BigInt(now.getTime()) << 80n) | BigInt(`0x${randomBytes(10).toString('hex')}`);
  let id = '';
  for (let i = 0; i < 26; i++) {
    id = (ALPHABET[Number(n & 31n)] ?? '0') + id;
    n >>= 5n;
  }
  return id;
}

const INVITE_CODE_LENGTH = 20; // 100 random bits: not guessable

/** A new invite code: 20 random Crockford base32 characters, stored without dashes. */
export function newInviteCode(): string {
  const bytes = randomBytes(INVITE_CODE_LENGTH);
  let code = '';
  for (const byte of bytes) code += ALPHABET[byte & 31]; // 256 is a multiple of 32: no bias
  return code;
}

/** The code as people see and paste it: `K7QX-M2PD-9VTR-H4NB-…`. */
export function formatInviteCode(code: string): string {
  return code.match(/.{1,4}/g)?.join('-') ?? code;
}

/**
 * A pasted or typed code back to its stored form: dashes and spaces dropped, upper case, and the
 * letters Crockford base32 leaves out read as the digits they look like (O → 0, I and L → 1).
 * Undefined if it can't be a code.
 */
export function parseInviteCode(input: string): string | undefined {
  const code = input
    .replace(/[\s-]/g, '')
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  return code.length === INVITE_CODE_LENGTH && [...code].every((c) => ALPHABET.includes(c)) ? code : undefined;
}
