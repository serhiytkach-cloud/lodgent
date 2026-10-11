/**
 * Operator tools for platform fees.
 *
 *   pnpm --filter @lodgent/scripts billing fees                      list fee rates per property
 *   pnpm --filter @lodgent/scripts billing set-fee <propertyId> 1.5  set a property's fee (percent)
 *   pnpm --filter @lodgent/scripts billing invoice 2026-09           invoice a finished month now
 */
import { createContainer, loadConfig, loadDotEnv } from '@lodgent/application';

loadDotEnv();
const container = createContainer(loadConfig(), { name: 'cli' });
const [command, ...args] = process.argv.slice(2).filter((a) => a !== '--');
const { billing } = container.services;

try {
  switch (command) {
    case 'fees':
      for (const p of await billing.listFeeRates()) {
        console.info(`${p.id}  ${(p.feeBps / 100).toFixed(2)}%  ${p.organizationName} / ${p.name}`);
      }
      break;
    case 'set-fee': {
      const [propertyId, percent] = args;
      if (!propertyId || percent === undefined)
        throw new Error('Usage: billing set-fee <propertyId> <percent>');
      const { from, to } = await billing.setFeeRate(propertyId, Math.round(Number(percent) * 100));
      console.info(`Fee changed from ${from / 100}% to ${to / 100}% (applies to new holds).`);
      break;
    }
    case 'invoice': {
      const [period] = args;
      if (!period) throw new Error('Usage: billing invoice <YYYY-MM>');
      const issued = await billing.invoicePeriod(period);
      for (const i of issued) {
        console.info(
          `${i.number ?? i.id}  ${i.status}  ${(i.amount / 100).toFixed(2)} ${i.currency}  ${i.hostedUrl ?? ''}`,
        );
      }
      console.info(`${issued.length} invoice(s).`);
      break;
    }
    default:
      console.info('Commands: fees | set-fee <propertyId> <percent> | invoice <YYYY-MM>');
  }
} finally {
  await container.close();
}
