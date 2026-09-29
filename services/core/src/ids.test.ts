import { describe, expect, it } from 'vitest';
import { newId } from './ids.js';

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
