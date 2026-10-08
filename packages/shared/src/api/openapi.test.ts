import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from './openapi.js';
import { API_ROUTES } from './routes.js';

// That the committed docs/api/openapi.json is current is checked in infra/test/api-spec.test.ts.
describe('buildOpenApiDocument', () => {
  it('documents every route, with its operation id', () => {
    const doc = buildOpenApiDocument() as { paths: Record<string, Record<string, { operationId: string }>> };
    for (const route of API_ROUTES) {
      expect(doc.paths[route.path]?.[route.method.toLowerCase()]?.operationId).toBe(route.id);
    }
  });

  it('documents the usual errors: 400 for bodies, 403 always, 404 for a path id', () => {
    const doc = buildOpenApiDocument() as { paths: Record<string, Record<string, { responses: Record<string, unknown> }>> };
    const start = doc.paths['/admin/servers/{id}/start']!.post!.responses;
    expect(Object.keys(start)).toEqual(['200', '202', '403', '404', '409']);
    const create = doc.paths['/admin/servers']!.post!.responses;
    expect(create).toHaveProperty('400');
  });
});
