import * as z from 'zod'; // a namespace import, so bundles that don't build the docs drop this (see schemas.ts)
import { API_ROUTES, type ApiRoute, type RouteResponse } from './routes.js';
import { apiSchemas } from './schemas.js';

// Builds openapi.json (OpenAPI 3.1, whose schemas are JSON Schema 2020-12: what Zod writes) from
// the route list and the named schemas. `pnpm api:spec` writes it to docs/api/openapi.json; a test
// fails when that file is stale.

type Json = Record<string, unknown>;

const ref = (id: string) => ({ $ref: `#/components/schemas/${id}` });

/** A body schema as OpenAPI wants it: a reference to its named component. */
function schemaRef(schema: z.ZodType): Json {
  const meta = apiSchemas.get(schema);
  if (!meta) throw new Error('Every request and response schema in API_ROUTES must be named (registered in apiSchemas)');
  return ref(meta.id);
}

/** A JSON Schema without the lines that only make sense in a standalone schema file. */
function embeddable(schema: Json): Json {
  return Object.fromEntries(Object.entries(schema).filter(([key]) => key !== '$schema' && key !== '$id'));
}

/** JSON Schema for a small, unnamed schema (a query parameter). */
function inlineSchema(schema: z.ZodType): Json {
  return embeddable(z.toJSONSchema(schema) as Json);
}

function components(): Record<string, Json> {
  const { schemas } = z.toJSONSchema(apiSchemas, { uri: (id) => `#/components/schemas/${id}` }) as { schemas: Record<string, Json> };
  return Object.fromEntries(
    Object.entries(schemas)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, schema]) => [id, embeddable(schema)]),
  );
}

const ERROR = { content: { 'application/json': { schema: ref('ErrorResponse') } } };

function response({ description, schema }: RouteResponse): Json {
  return schema ? { description, content: { 'application/json': { schema: schemaRef(schema) } } } : { description, ...ERROR };
}

function operation(route: ApiRoute): Json {
  const pathParams = [...route.path.matchAll(/\{(\w+)\}/g)].map(([, name]) => ({
    name,
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }));
  const queryParams = route.query
    ? Object.entries(route.query.shape).map(([name, schema]) => {
        const s = schema as z.ZodType;
        const json = inlineSchema(s);
        return {
          name,
          in: 'query',
          required: !s.safeParse(undefined).success,
          ...(json.description ? { description: json.description } : {}),
          schema: json,
        };
      })
    : [];
  const parameters = [...pathParams, ...queryParams];

  const responses: Record<string, Json> = {};
  for (const [status, r] of Object.entries(route.responses)) responses[status] = response(r);
  // The answers every route can give.
  if (route.body || route.query) responses['400'] ??= { description: 'The request is malformed (the message says how)', ...ERROR };
  if (route.caller.kind === 'user') {
    // API Gateway's own answer, before Hearth sees the request.
    responses['401'] ??= { description: 'No ID token, or an invalid or expired one: sign in again', ...ERROR };
  }
  const adminOnly = route.caller.kind === 'user' && route.caller.adminOnly === true;
  if (route.caller.kind !== 'user' || route.caller.action || adminOnly) {
    responses['403'] ??= {
      description:
        route.caller.kind === 'agent'
          ? 'The caller is not a game instance'
          : adminOnly
            ? 'The caller is not a Hearth admin'
            : 'The caller may not do this',
      ...ERROR,
    };
  }
  if (pathParams.length) responses['404'] ??= { description: 'No such server (or none the caller can reach)', ...ERROR };
  if (route.caller.kind === 'agent') responses['404'] ??= { description: 'No server is assigned to this instance', ...ERROR };

  return {
    operationId: route.id,
    summary: route.summary,
    ...(route.description ? { description: route.description } : {}),
    tags: [route.caller.kind],
    security: [route.caller.kind === 'user' ? { cognito: [] } : { awsSigV4: [] }],
    ...(route.caller.kind === 'user' && route.caller.action ? { 'x-hearth-permission': route.caller.action } : {}),
    ...(adminOnly ? { 'x-hearth-admin-only': true } : {}),
    ...(parameters.length ? { parameters } : {}),
    ...(route.body ? { requestBody: { required: true, content: { 'application/json': { schema: schemaRef(route.body) } } } } : {}),
    responses: Object.fromEntries(Object.entries(responses).sort(([a], [b]) => a.localeCompare(b))),
  };
}

/** The OpenAPI 3.1 document for `routes` (default: every route the API serves). */
export function buildOpenApiDocument(routes: readonly ApiRoute[] = API_ROUTES): Json {
  const paths: Record<string, Record<string, Json>> = {};
  for (const route of routes) {
    (paths[route.path] ??= {})[route.method.toLowerCase()] = operation(route);
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Hearth API',
      version: '1',
      description:
        "Hearth's HTTP API. Each environment serves it at the address in SSM `/hearth/<env>/api-url`. " +
        'Generated from packages/shared/src/api (routes.ts, schemas.ts): edit those, then `pnpm api:spec`.',
    },
    servers: [
      {
        url: '{apiUrl}',
        description: "An environment's API",
        variables: {
          apiUrl: {
            default: 'https://example.execute-api.us-west-2.amazonaws.com',
            description: 'The value of SSM /hearth/<env>/api-url',
          },
        },
      },
    ],
    tags: [
      { name: 'user', description: 'Signed-in users (the web app): themselves, and the servers they own or are members of' },
      { name: 'admin', description: 'Hearth admins (the hearth CLI): every server, uploads' },
      { name: 'agent', description: "Game instances' agents, about their own server" },
    ],
    paths: Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b))),
    components: {
      securitySchemes: {
        cognito: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description:
            "The ID token from signing in through the environment's Cognito user pool (SSM /hearth/<env>/auth). " +
            'It names the user and their profile; API Gateway checks it before the request reaches Hearth.',
        },
        awsSigV4: {
          type: 'apiKey',
          in: 'header',
          name: 'Authorization',
          description: 'AWS Signature Version 4 (IAM): admins with their AWS credentials, agents with their instance role',
        },
      },
      schemas: components(),
    },
  };
}
