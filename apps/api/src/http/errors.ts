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

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | Error, req, reply) => {
    if (error instanceof DomainError) {
      const status = statusFor(error);
      if (status >= 500) req.log.warn({ err: error }, 'upstream failure');
      return reply
        .status(status)
        .send({ error: { code: error.code, message: error.message, details: error.details } });
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
    if (statusCode < 500) {
      return reply.status(statusCode).send({ error: { code: 'invalid_request', message: error.message } });
    }
    req.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({
      error: { code: 'internal_error', message: 'Something went wrong', details: { requestId: req.id } },
    });
  });

  app.setNotFoundHandler((req, reply) => {
    reply
      .status(404)
      .send({ error: { code: 'not_found', message: `No route for ${req.method} ${req.url.split('?')[0]}` } });
  });
}
