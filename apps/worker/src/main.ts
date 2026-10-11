import {
  createContainer,
  createJobHandlers,
  LocalScheduler,
  loadConfig,
  loadDotEnv,
  PgJobRunner,
  SqsJobConsumer,
} from '@lodgent/application';

loadDotEnv();
const config = loadConfig();
const container = createContainer(config, { name: 'worker' });
await container.init();
const { logger } = container;
const handlers = createJobHandlers(container);
const controller = new AbortController();
const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    controller.signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });

/** Runs `step` until shutdown; `step` returns how long to wait before the next run. */
async function loop(name: string, step: () => Promise<number>): Promise<void> {
  while (!controller.signal.aborted) {
    let wait = 1000;
    try {
      wait = await step();
    } catch (error) {
      if (controller.signal.aborted) break;
      logger.error({ err: error, loop: name }, 'worker loop error');
      wait = 5000;
    }
    if (wait > 0) await sleep(wait);
  }
}

const loops: Promise<void>[] = [];

// Outbox: deliver side effects committed by API transactions.
loops.push(loop('outbox', async () => ((await container.services.outbox.dispatchBatch(50)) > 0 ? 0 : 1000)));

// Jobs: Postgres queue locally, SQS in AWS (where EventBridge Scheduler enqueues recurring jobs).
if (config.queue.provider === 'sqs') {
  const consumer = new SqsJobConsumer({
    queueUrl: config.queue.queueUrl,
    region: config.aws.region,
    endpoint: config.aws.endpointUrl,
    logger,
    handlers,
  });
  loops.push(loop('sqs', async () => ((await consumer.pollOnce(controller.signal)) > 0 ? 0 : 0)));
} else {
  const runner = new PgJobRunner({ db: container.db, clock: container.clock, logger, handlers });
  loops.push(loop('jobs', async () => ((await runner.runOnce(5)) > 0 ? 0 : 1000)));
  const scheduler = new LocalScheduler(container.queue, logger);
  scheduler.start();
  controller.signal.addEventListener('abort', () => scheduler.stop());
}

logger.info({ queue: config.queue.provider, jobTypes: Object.keys(handlers) }, 'worker started');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    if (controller.signal.aborted) return;
    logger.info({ signal }, 'worker stopping');
    controller.abort();
    await Promise.allSettled(loops);
    await container.close();
    process.exit(0);
  });
}
