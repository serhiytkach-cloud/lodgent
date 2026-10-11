import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';

describe('health', () => {
  it('responds', async () => {
    const app = await buildApp({ logLevel: 'silent' });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    await app.close();
  });
});
