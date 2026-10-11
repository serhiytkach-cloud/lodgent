/**
 * Recurring jobs. This is pure data shared by two consumers:
 *  - AWS: the CDK app (infra/) creates one EventBridge Scheduler schedule per entry that sends
 *    `{ type, payload }` to the jobs SQS queue, where the worker's SQS consumer picks it up.
 *  - Local: the worker's in-process `LocalScheduler` (@lodgent/application) enqueues due entries.
 */
export interface Schedule {
  /** Unique, used as the EventBridge schedule name: letters, digits, hyphens; at most 64 characters. */
  name: string;
  /** Run every N minutes, aligned to the epoch (local scheduler). */
  everyMinutes: number;
  /** EventBridge Scheduler `rate()` or `cron()` expression, evaluated in UTC (AWS). */
  expression: string;
  job: { type: string; payload: Record<string, unknown> };
}

export const SCHEDULES: readonly Schedule[] = [
  {
    name: 'pms-sync-all',
    everyMinutes: 360,
    expression: 'rate(6 hours)',
    job: { type: 'pms.sync-all', payload: {} },
  },
  {
    name: 'holds-expire',
    everyMinutes: 1,
    expression: 'rate(1 minute)',
    job: { type: 'holds.expire', payload: {} },
  },
  {
    name: 'checkout-reconcile',
    everyMinutes: 5,
    expression: 'rate(5 minutes)',
    job: { type: 'checkout.reconcile', payload: {} },
  },
  {
    name: 'privacy-retention',
    everyMinutes: 1440,
    expression: 'cron(30 3 * * ? *)',
    job: { type: 'privacy.retention', payload: {} },
  },
  {
    name: 'visibility-weekly',
    everyMinutes: 7 * 1440,
    expression: 'cron(15 4 ? * MON *)',
    job: { type: 'visibility.schedule-all', payload: {} },
  },
  {
    name: 'visibility-purge',
    everyMinutes: 1440,
    expression: 'cron(45 3 * * ? *)',
    job: { type: 'visibility.purge', payload: {} },
  },
  {
    // Invoices last month's pay-at-hotel fees (idempotent per period) and re-checks open invoices.
    name: 'billing-daily',
    everyMinutes: 1440,
    expression: 'cron(10 6 * * ? *)',
    job: { type: 'billing.daily', payload: {} },
  },
  {
    name: 'offers-cleanup',
    everyMinutes: 60,
    expression: 'rate(1 hour)',
    job: { type: 'offers.cleanup', payload: {} },
  },
];
