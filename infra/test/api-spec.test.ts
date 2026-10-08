import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from '@hearth/shared/api';

// The API's committed documentation must match what it serves: routes and schemas in
// packages/shared/src/api. (Here rather than in packages/shared, which stays free of Node APIs.)
describe('docs/api/openapi.json', () => {
  it('is up to date with the routes and schemas (if not: pnpm api:spec)', () => {
    const committed = readFileSync(new URL('../../docs/api/openapi.json', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    expect(committed).toBe(`${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`);
  });
});
