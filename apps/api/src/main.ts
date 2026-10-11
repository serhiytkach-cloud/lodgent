import { buildApp } from './app';

const app = await buildApp({ logLevel: process.env.LOG_LEVEL ?? 'info' });
const port = Number(process.env.API_PORT ?? 4000);
await app.listen({ port, host: '0.0.0.0' });
