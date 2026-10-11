import {
  ConflictError,
  DomainError,
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
  UnauthorizedError,
  UnprocessableError,
  UpstreamError,
  ValidationError,
} from '@lodgent/core';
import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { redactUrl } from './security';

export function statusFor(error: DomainError): number {
  if (error instanceof ValidationError) return 400;
  if (error instanceof UnauthorizedError) return 401;
  if (error instanceof ForbiddenError) return 403;
  if (error instanceof NotFoundError) return 404;
  if (error instanceof ConflictError) return 409;
  if (error instanceof UnprocessableError) return 422;
  if (error instanceof RateLimitedError) return 429;
  if (error instanceof UpstreamError) return 502;
  return 400;
}

/**
 * What a client may see of a domain error. Upstream failures keep only the service name and its
 * HTTP status: raw upstream bodies (PMS or payment responses) are logged, never returned.
 */
export function publicDetails(error: DomainError): Record<string, unknown> | undefined {
  if (!(error instanceof UpstreamError)) return error.details;
  const status = error.details?.status;
  return { service: error.service, ...(typeof status === 'number' ? { status } : {}) };
}

/** Errors raised by Fastify itself for a malformed request (bad JSON, body too large, wrong media type). */
function isFastifyClientError(error: unknown, statusCode: number): boolean {
  const code = (error as Partial<FastifyError>).code;
  return statusCode >= 400 && statusCode < 500 && typeof code === 'string' && code.startsWith('FST_');
}

const CLIENT_ERROR_CODES: Record<number, string> = {
  404: 'not_found',
  405: 'method_not_allowed',
  406: 'not_acceptable',
  413: 'payload_too_large',
  414: 'uri_too_long',
  415: 'unsupported_media_type',
  431: 'headers_too_large',
};

/**
 * One JSON error shape everywhere. Clients get stable codes and messages written for them; anything
 * unexpected (including a library error that happens to carry a 4xx status) is logged with the
 * request id and returned as a generic 500, so stack traces and internals never leave the server.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | Error, req, reply) => {
    if (error instanceof DomainError) {
      const status = statusFor(error);
      if (status >= 500) req.log.warn({ err: error }, 'upstream failure');
      return reply
        .status(status)
        .send({ error: { code: error.code, message: error.message, details: publicDetails(error) } });
    }
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: 'invalid_request',
          message: 'Invalid request',
          details: { issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
        },
      });
    }
    const statusCode = 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (statusCode === 429) {
      return reply
        .status(429)
        .send({ error: { code: 'rate_limited', message: 'Too many requests. Slow down.' } });
    }
    if (isFastifyClientError(error, statusCode)) {
      return reply.status(statusCode).send({
        error: { code: CLIENT_ERROR_CODES[statusCode] ?? 'invalid_request', message: error.message },
      });
    }
    req.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({
      error: { code: 'internal_error', message: 'Something went wrong', details: { requestId: req.id } },
    });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({
      error: { code: 'not_found', message: `No route for ${req.method} ${redactUrl(req.url).split('?')[0]}` },
    });
  });
}
