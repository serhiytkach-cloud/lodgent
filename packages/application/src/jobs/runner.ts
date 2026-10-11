import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { Clock } from '@lodgent/core';
import type { Database } from '@lodgent/db';
import type { Logger } from 'pino';
import { z } from 'zod';
import { type JobHandler, RetryLaterError } from './registry';

const LEASE_SECONDS = 300;

function backoffSeconds(attempt: number): number {
  return Math.min(30 * 2 ** (attempt - 1), 3600);
}

async function runHandler(
  handlers: Record<string, JobHandler>,
  type: string,
  payload: Record<string, unknown>,
  attempt: number,
  logger: Logger,
): Promise<void> {
  const handler = handlers[type];
  if (!handler) throw new Error(`No handler for job type ${type}`);
  const started = Date.now();
  await handler(payload, { logger: logger.child({ job: type, attempt }), attempt });
  logger.debug({ job: type, ms: Date.now() - started }, 'job done');
}

/** Polls the Postgres `jobs` table (local development and tests). */
export class PgJobRunner {
  constructor(
    private readonly deps: {
      db: Database;
      clock: Clock;
      logger: Logger;
      handlers: Record<string, JobHandler>;
    },
  ) {}

  /** Claims and runs up to `limit` due jobs. Returns how many ran. */
  async runOnce(limit = 5): Promise<number> {
    const { db, clock, logger, handlers } = this.deps;
    const now = clock.now();
    const jobs = await db.system(({ jobs }) =>
      jobs.claim(now, new Date(now.getTime() + LEASE_SECONDS * 1000), limit),
    );
    for (const job of jobs) {
      try {
        await runHandler(handlers, job.type, job.payload, job.attempts, logger);
        await db.system(({ jobs: repo }) => repo.complete(job.id, clock.now()));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof RetryLaterError) {
          await db.system(({ jobs: repo }) =>
            repo.retry(job.id, message, new Date(clock.now().getTime() + error.delaySeconds * 1000)),
          );
        } else if (job.attempts >= job.maxAttempts) {
          logger.error({ err: error, job: job.type, jobId: job.id }, 'job failed permanently');
          await db.system(({ jobs: repo }) => repo.fail(job.id, message, clock.now()));
        } else {
          logger.warn(
            { err: error, job: job.type, jobId: job.id, attempt: job.attempts },
            'job failed, will retry',
          );
          await db.system(({ jobs: repo }) =>
            repo.retry(
              job.id,
              message,
              new Date(clock.now().getTime() + backoffSeconds(job.attempts) * 1000),
            ),
          );
        }
      }
    }
    return jobs.length;
  }
}

const SqsBody = z.object({ type: z.string(), payload: z.record(z.string(), z.unknown()) });

/**
 * Long-polls SQS. A message is deleted only after its handler succeeds; failures become visible
 * again after the visibility timeout and land in the dead-letter queue after maxReceiveCount.
 */
export class SqsJobConsumer {
  private readonly client: SQSClient;

  constructor(
    private readonly options: {
      queueUrl: string;
      region: string;
      endpoint?: string;
      logger: Logger;
      handlers: Record<string, JobHandler>;
    },
  ) {
    this.client = new SQSClient({ region: options.region, endpoint: options.endpoint });
  }

  async pollOnce(signal?: AbortSignal): Promise<number> {
    const { queueUrl, logger, handlers } = this.options;
    const result = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 20,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
      { abortSignal: signal },
    );
    const messages = result.Messages ?? [];
    await Promise.all(
      messages.map(async (message) => {
        const attempt = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
        try {
          const body = SqsBody.parse(JSON.parse(message.Body ?? '{}'));
          await runHandler(handlers, body.type, body.payload, attempt, logger);
          await this.client.send(
            new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
          );
        } catch (error) {
          logger.warn(
            { err: error, messageId: message.MessageId, attempt },
            'SQS job failed; it will be retried',
          );
        }
      }),
    );
    return messages.length;
  }
}
