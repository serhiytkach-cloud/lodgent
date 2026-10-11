import type { Logger } from 'pino';
import type { Container } from '../container';

export interface JobContext {
  logger: Logger;
  /** 1 on the first attempt. */
  attempt: number;
}

export type JobHandler = (payload: Record<string, unknown>, ctx: JobContext) => Promise<void>;

/** A job that should be retried later without counting as a failure (e.g. upstream rate limit). */
export class RetryLaterError extends Error {
  constructor(
    message: string,
    readonly delaySeconds: number,
  ) {
    super(message);
  }
}

/**
 * Every background job type and its handler. Handlers must be idempotent: SQS delivers at least
 * once and the Postgres queue retries after a crash.
 */
export function createJobHandlers(container: Container): Record<string, JobHandler> {
  return {
    'outbox.dispatch': async () => {
      await container.services.outbox.dispatchBatch(100);
    },
  };
}
