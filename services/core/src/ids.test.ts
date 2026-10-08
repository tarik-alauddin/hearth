import { describe, expect, it } from 'vitest';
import { formatInviteCode, newId, newInviteCode, parseInviteCode } from './ids.js';

describe('newId', () => {
  it('is a 26-character ULID', () => {
    expect(newId()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('sorts by creation time', () => {
    const earlier = newId(new Date('2026-09-29T12:00:00Z'));
    const later = newId(new Date('2026-09-29T12:00:01Z'));
    expect(earlier < later).toBe(true);
  });

  it('encodes the time in the first 10 characters', () => {
    expect(newId(new Date(0)).slice(0, 10)).toBe('0000000000');
  });
});

describe('invite codes', () => {
  it('are 20 Crockford base32 characters, different each time', () => {
    const a = newInviteCode();
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{20}$/);
    expect(newInviteCode()).not.toBe(a);
  });

  it('show in groups of four', () => {
    expect(formatInviteCode('K7QXM2PD9VTRH4NBW3ZA')).toBe('K7QX-M2PD-9VTR-H4NB-W3ZA');
  });

  it('read back however they were pasted or typed', () => {
    expect(parseInviteCode('K7QX-M2PD-9VTR-H4NB-W3ZA')).toBe('K7QXM2PD9VTRH4NBW3ZA');
    expect(parseInviteCode(' k7qx m2pd 9vtr h4nb w3za ')).toBe('K7QXM2PD9VTRH4NBW3ZA');
    // Letters base32 leaves out, read as the digits they look like.
    expect(parseInviteCode('O0IL-0000-0000-0000-0000')).toBe('00110000000000000000');
  });

  it('refuse what cannot be a code', () => {
    expect(parseInviteCode('K7QX-M2PD')).toBeUndefined(); // too short
    expect(parseInviteCode('K7QX-M2PD-9VTR-H4NB-W3ZU')).toBeUndefined(); // U isn't in the alphabet
    expect(parseInviteCode('../../etc/passwd/xxxxxx')).toBeUndefined();
  });
});
