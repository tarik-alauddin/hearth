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
