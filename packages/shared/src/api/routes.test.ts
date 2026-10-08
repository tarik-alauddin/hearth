import { describe, expect, it } from 'vitest';
import { API_ROUTES } from './routes.js';
import { apiSchemas } from './schemas.js';

describe('API_ROUTES', () => {
  it('has unique operation ids and method + path pairs', () => {
    expect(new Set(API_ROUTES.map((r) => r.id)).size).toBe(API_ROUTES.length);
    expect(new Set(API_ROUTES.map((r) => `${r.method} ${r.path}`)).size).toBe(API_ROUTES.length);
  });

  it('gives every route a success response', () => {
    for (const route of API_ROUTES) {
      expect(Object.keys(route.responses).some((status) => status.startsWith('2')), route.id).toBe(true);
    }
  });

  it('names every body and response schema, so the docs can reference them', () => {
    for (const route of API_ROUTES) {
      const schemas = [route.body, ...Object.values(route.responses).map((r) => r?.schema)].filter((s) => s !== undefined);
      for (const schema of schemas) expect(apiSchemas.get(schema), route.id).toBeDefined();
    }
  });

  it('keeps each family of routes under its own prefix and caller', () => {
    for (const route of API_ROUTES) {
      expect(route.path, route.id).toMatch(/^\/(admin|agent|v1)\/[a-z0-9{}/-]+$/);
      const prefix = route.path.split('/')[1];
      expect({ admin: 'admin', agent: 'agent', v1: 'user' }[prefix!], route.id).toBe(route.caller.kind);
    }
  });
});
