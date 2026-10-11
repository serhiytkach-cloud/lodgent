import type { Container, OrgContext, UserContext } from '@lodgent/application';
import {
  can,
  ForbiddenError,
  NotFoundError,
  type Permission,
  UnauthorizedError,
  ValidationError,
} from '@lodgent/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { type AgentContext, resolveAgent } from './agent-auth';
import { agentRateLimit } from './rate-limit';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * - `none`: public, no identity.
 * - `user`: a signed-in hotel user (bearer token from the identity provider).
 * - `org`: a signed-in member of `:orgId` holding `permission`.
 * - `agent`: AI agent surface; partner API key optional, anonymous callers get stricter limits.
 */
export type AuthMode = 'none' | 'user' | 'org' | 'agent';

/** Which OpenAPI document a route belongs to. */
export type Audience = 'agent' | 'dashboard' | 'checkout' | 'webhook' | 'system';

type AuthFor<M extends AuthMode> = M extends 'org'
  ? { org: OrgContext }
  : M extends 'user'
    ? { user: UserContext }
    : M extends 'agent'
      ? { agent: AgentContext }
      : Record<never, never>;

export interface RouteDef<M extends AuthMode, P, Q, B, R> {
  method: HttpMethod;
  path: string;
  operationId: string;
  summary: string;
  description?: string;
  tags: readonly string[];
  audience: Audience;
  auth: M;
  permission?: M extends 'org' ? Permission : never;
  params?: z.ZodType<P>;
  query?: z.ZodType<Q>;
  body?: z.ZodType<B>;
  /** `null` for 204 No Content. Responses are parsed with this schema, which strips unknown keys. */
  response: z.ZodType<R> | null;
  status?: number;
  /** Requests per minute per caller; defaults depend on the auth mode. */
  rateLimitPerMinute?: number;
  /** Accept a raw body (webhooks verify signatures over the exact bytes). */
  rawBody?: boolean;
  handler: (
    input: { params: P; query: Q; body: B; req: FastifyRequest; reply: FastifyReply } & AuthFor<M>,
  ) => Promise<R>;
}

// biome-ignore lint/suspicious/noExplicitAny: registry stores heterogeneous route definitions.
export type AnyRouteDef = RouteDef<AuthMode, any, any, any, any>;

export const ParamsWithOrg = z.object({ orgId: z.uuid() });

function parseInput<T>(schema: z.ZodType<T> | undefined, value: unknown, where: string): T {
  if (!schema) return undefined as T;
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw new ValidationError(`Invalid ${where}`, {
      issues: result.error.issues.map((i) => ({ path: [where, ...i.path].join('.'), message: i.message })),
    });
  }
  return result.data;
}

function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : null;
}

export class Router {
  readonly routes: AnyRouteDef[] = [];

  constructor(
    private readonly app: FastifyInstance,
    private readonly container: Container,
  ) {}

  add<M extends AuthMode, P, Q, B, R>(def: RouteDef<M, P, Q, B, R>): void {
    this.routes.push(def as unknown as AnyRouteDef);
    const container = this.container;
    const limit = def.rateLimitPerMinute ?? (def.auth === 'none' ? 120 : 600);

    this.app.route({
      method: def.method,
      url: def.path,
      config: {
        rawBody: def.rawBody ?? false,
        rateLimit:
          def.auth === 'agent'
            ? agentRateLimit(container, def.rateLimitPerMinute)
            : {
                max: limit,
                timeWindow: '1 minute',
                keyGenerator: (req: FastifyRequest) => `ip:${req.ip}`,
              },
      },
      handler: async (req, reply) => {
        // Authenticate before looking at the query or body so unauthorized callers learn nothing.
        const params = parseInput(def.params, req.params, 'path');
        const auth = await this.authenticate(def, req, params);
        const query = parseInput(def.query, req.query, 'query');
        const body = def.rawBody ? (req.body as B) : parseInput(def.body, req.body, 'body');

        const result = await def.handler({ params, query, body, req, reply, ...auth } as Parameters<
          typeof def.handler
        >[0]);
        if (reply.sent) return reply;
        if (def.response === null) return reply.status(def.status ?? 204).send();
        const output = def.response.safeParse(result);
        if (!output.success) {
          req.log.error(
            { issues: output.error.issues, operationId: def.operationId },
            'response failed schema',
          );
          throw new Error(`Response for ${def.operationId} did not match its schema`);
        }
        return reply.status(def.status ?? 200).send(output.data);
      },
    });
  }

  private async authenticate(
    def: AnyRouteDef,
    req: FastifyRequest,
    params: unknown,
  ): Promise<Record<string, unknown>> {
    switch (def.auth) {
      case 'none':
        return {};
      case 'agent':
        return { agent: await resolveAgent(req, this.container) };
      case 'user':
        return { user: await this.resolveUser(req) };
      case 'org': {
        const user = await this.resolveUser(req);
        const { orgId } = ParamsWithOrg.parse(params);
        const role = await this.container.services.accounts.roleIn(user.userId, orgId);
        // Non-members get 404 rather than 403 so organization IDs can't be probed.
        if (!role) throw new NotFoundError('Organization');
        if (def.permission && !can(role, def.permission)) throw new ForbiddenError();
        const org: OrgContext = { ...user, orgId, role };
        return { org };
      }
    }
  }

  private async resolveUser(req: FastifyRequest): Promise<UserContext> {
    const token = bearerToken(req);
    if (!token) throw new UnauthorizedError();
    const identity = await this.container.identity.verify(token);
    if (!identity) throw new UnauthorizedError('Your session has expired. Sign in again.');
    const user = await this.container.services.accounts.resolveUser(identity);
    return { userId: user.id, email: user.email, requestId: req.id };
  }
}
