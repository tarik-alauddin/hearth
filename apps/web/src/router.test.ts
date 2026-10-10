import { describe, expect, it } from 'vitest';
import { safeReturnTo } from './router';

describe('safeReturnTo', () => {
  it('follows paths inside the app only', () => {
    expect(safeReturnTo('/app/servers/s1')).toBe('/app/servers/s1');
    expect(safeReturnTo('//evil.example/x')).toBe('/app');
    expect(safeReturnTo('https://evil.example')).toBe('/app');
    expect(safeReturnTo(undefined)).toBe('/app');
  });
});
