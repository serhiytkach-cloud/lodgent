/**
 * Manages partner API keys (agent platforms that want attribution and higher rate limits).
 *
 *   pnpm --filter @lodgent/scripts partner-key create "Trip Planner AI" [contact@example.com]
 *   pnpm --filter @lodgent/scripts partner-key list
 *   pnpm --filter @lodgent/scripts partner-key revoke <id>
 */
import { createContainer, loadConfig, loadDotEnv } from '@lodgent/application';

loadDotEnv();
const container = createContainer(loadConfig(), { name: 'cli' });
const [command, ...args] = process.argv.slice(2);
const { agentClients } = container.services;

try {
  switch (command) {
    case 'create': {
      const [name, contactEmail] = args;
      if (!name) throw new Error('Usage: partner-key create <name> [contact email]');
      const created = await agentClients.create({ name, contactEmail: contactEmail ?? null });
      console.info(`Created partner ${created.name} (${created.id}).`);
      console.info(`API key (shown once, store it now): ${created.apiKey}`);
      break;
    }
    case 'list':
      for (const c of await agentClients.list()) {
        console.info(
          `${c.id}  ${c.keyPrefix}…  ${c.name}  ${c.revokedAt ? `revoked ${c.revokedAt.toISOString()}` : 'active'}  last used ${c.lastUsedAt?.toISOString() ?? 'never'}`,
        );
      }
      break;
    case 'revoke': {
      const revoked = args[0] ? await agentClients.revoke(args[0]) : undefined;
      console.info(revoked ? `Revoked ${revoked.name}.` : 'No active partner with that id.');
      break;
    }
    default:
      console.info('Commands: create <name> [email] | list | revoke <id>');
  }
} finally {
  await container.close();
}
