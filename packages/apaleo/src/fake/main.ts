import { createFakeApaleo } from './server';

/** Runs the fake Apaleo server for local development (`pnpm dev` starts it on :4010). */
const port = Number(process.env.FAKE_APALEO_PORT ?? 4010);
const fake = createFakeApaleo({
  clientId: process.env.APALEO_CLIENT_ID || undefined,
  clientSecret: process.env.APALEO_CLIENT_SECRET || undefined,
});
await fake.app.listen({ port, host: '0.0.0.0' });
console.info(`Fake Apaleo listening on http://localhost:${port}`);
