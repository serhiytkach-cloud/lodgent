import { BRAND, ErrorResponse } from '@lodgent/shared';
import { z } from 'zod';
import type { AnyRouteDef, Audience } from './router';

type JsonSchema = Record<string, unknown>;

function toSchema(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12', io, unrepresentable: 'any' }) as JsonSchema;
  delete json.$schema;
  return json;
}

function parametersFrom(schema: z.ZodType | undefined, location: 'path' | 'query') {
  if (!schema) return [];
  const json = toSchema(schema, 'input');
  const properties = (json.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((json.required as string[] | undefined) ?? []);
  return Object.entries(properties).map(([name, prop]) => {
    const { description, ...rest } = prop;
    return {
      name,
      in: location,
      required: location === 'path' ? true : required.has(name),
      description: typeof description === 'string' ? description : undefined,
      schema: rest,
    };
  });
}

const SECURITY = {
  user: [{ bearerAuth: [] }],
  org: [{ bearerAuth: [] }],
  agent: [{}, { apiKey: [] }, { partnerBearer: [] }],
  none: [],
} as const;

export interface OpenApiOptions {
  audiences: Audience[];
  title: string;
  description: string;
  serverUrl: string;
}

/** Builds an OpenAPI 3.1 document from the registered routes. Schemas come from the same Zod
 * definitions that validate requests and responses at runtime. */
export function buildOpenApi(routes: AnyRouteDef[], options: OpenApiOptions) {
  const paths: Record<string, Record<string, unknown>> = {};
  const errorSchema = toSchema(ErrorResponse, 'output');

  for (const route of routes) {
    if (!options.audiences.includes(route.audience)) continue;
    const path = route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    const operation: Record<string, unknown> = {
      operationId: route.operationId,
      summary: route.summary,
      description: route.description,
      tags: route.tags,
      parameters: [...parametersFrom(route.params, 'path'), ...parametersFrom(route.query, 'query')],
      security: SECURITY[route.auth],
      responses: {
        [String(route.status ?? (route.response === null ? 204 : 200))]: route.response
          ? {
              description: 'OK',
              content: {
                [route.produces ?? 'application/json']: route.produces
                  ? { schema: { type: 'string' } }
                  : { schema: toSchema(route.response, 'output') },
              },
            }
          : { description: 'No content' },
        default: { description: 'Error', content: { 'application/json': { schema: errorSchema } } },
      },
    };
    if (route.body && !route.rawBody) {
      operation.requestBody = {
        required: true,
        content: { 'application/json': { schema: toSchema(route.body, 'input') } },
      };
    }
    paths[path] = { ...(paths[path] ?? {}), [route.method.toLowerCase()]: operation };
  }

  return {
    openapi: '3.1.0',
    jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    info: { title: options.title, version: '1.0.0', description: options.description },
    servers: [{ url: options.serverUrl }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Hotel user session token',
        },
        apiKey: {
          type: 'apiKey',
          in: 'header',
          name: 'X-Api-Key',
          description: `Partner API key (${BRAND.apiKeyPrefix}_live_…). Optional: anonymous access is allowed with lower rate limits.`,
        },
        partnerBearer: {
          type: 'http',
          scheme: 'bearer',
          description: 'Partner API key sent as a bearer token',
        },
      },
    },
  };
}
