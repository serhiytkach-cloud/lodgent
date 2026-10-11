import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { JobQueue, QueuedJob } from '@lodgent/core';
import type { Database } from '@lodgent/db';

/** Postgres-backed queue: local development and tests. The worker polls the `jobs` table. */
export class PgJobQueue implements JobQueue {
  constructor(private readonly db: Database) {}

  async enqueue(job: QueuedJob): Promise<void> {
    const runAt = job.delaySeconds ? new Date(Date.now() + job.delaySeconds * 1000) : undefined;
    await this.db.system(({ jobs }) =>
      jobs.enqueue(job.type, job.payload, { runAt, dedupeKey: job.dedupeKey }),
    );
  }
}

/** SQS standard queue in AWS. Handlers are idempotent, so at-least-once delivery is fine. */
export class SqsJobQueue implements JobQueue {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  static create(options: { queueUrl: string; region: string; endpoint?: string }): SqsJobQueue {
    return new SqsJobQueue(
      new SQSClient({ region: options.region, endpoint: options.endpoint }),
      options.queueUrl,
    );
  }

  async enqueue(job: QueuedJob): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify({ type: job.type, payload: job.payload, dedupeKey: job.dedupeKey }),
        DelaySeconds: job.delaySeconds ? Math.min(job.delaySeconds, 900) : undefined,
      }),
    );
  }
}
