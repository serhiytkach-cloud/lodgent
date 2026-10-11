import { createContainer, loadConfig, loadDotEnv } from '@lodgent/application';
import { buildApp } from './app';

loadDotEnv();
const config = loadConfig();
const container = createContainer(config, { name: 'api' });
const { server } = await buildApp(container);

await server.listen({ port: config.apiPort, host: '0.0.0.0' });

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    server.log.info({ signal }, 'shutting down');
    await server.close();
    await container.close();
    process.exit(0);
  });
}
