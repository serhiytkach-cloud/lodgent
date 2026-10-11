import { createFakeStripe } from './server';

/** Runs the fake Stripe API for local development (`pnpm dev` starts it on :4020). */
const port = Number(process.env.FAKE_STRIPE_PORT ?? 4020);
const publicUrl = process.env.FAKE_STRIPE_PUBLIC_URL ?? `http://localhost:${port}`;
const apiBase = process.env.API_BASE_URL ?? 'http://localhost:4000';
const fake = createFakeStripe({
  secretKey: process.env.STRIPE_SECRET_KEY || undefined,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || undefined,
  webhookUrl: `${apiBase}/webhooks/stripe`,
  publicUrl,
});
await fake.app.listen({ port, host: '0.0.0.0' });
console.info(`Fake Stripe listening on ${publicUrl} (webhooks → ${apiBase}/webhooks/stripe)`);
