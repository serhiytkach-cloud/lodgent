/**
 * Domain errors. Adapters and the HTTP layer translate these into status codes; the `code` is a
 * stable, machine-readable string that agents and the dashboard can branch on.
 */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends DomainError {
  constructor(entity: string, details?: Record<string, unknown>) {
    super('not_found', `${entity} not found`, details);
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = 'You do not have permission to do this') {
    super('forbidden', message);
  }
}

export class UnauthorizedError extends DomainError {
  constructor(message = 'Sign in required') {
    super('unauthorized', message);
  }
}

export class ConflictError extends DomainError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(code, message, details);
  }
}

export class ValidationError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('invalid_request', message, details);
  }
}

/** A request that is valid but can't be fulfilled in the current state (expired hold, price changed…). */
export class UnprocessableError extends DomainError {}

/** An upstream system (PMS, payment provider, LLM) failed or rejected the call. */
export class UpstreamError extends DomainError {
  constructor(
    readonly service: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super('upstream_error', message, { service, ...details });
  }
}

export class RateLimitedError extends DomainError {
  constructor(message = 'Too many requests') {
    super('rate_limited', message);
  }
}
