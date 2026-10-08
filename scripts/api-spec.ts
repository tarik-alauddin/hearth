// Writes docs/api/openapi.json from the route list and schemas (packages/shared/src/api).
// `pnpm api:spec`; a test fails when the committed file is stale.
import { writeFileSync } from 'node:fs';
import { buildOpenApiDocument } from '../packages/shared/src/api/index.js';

const file = new URL('../docs/api/openapi.json', import.meta.url);
writeFileSync(file, `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`);
console.log(`Wrote ${file.pathname}`);
