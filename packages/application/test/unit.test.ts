import { describe, expect, it } from 'vitest';
import { ConfigError, DEV_SECRETS, loadConfig } from '../src/config';
import { escapeHtml, invitationEmail } from '../src/email/templates';
import { LocalKeyManagement } from '../src/infra/kms';

describe('local envelope encryption', () => {
  const kms = new LocalKeyManagement(DEV_SECRETS.localKmsMasterKey);

  it('round-trips with the same context', async () => {
    const sealed = await kms.encrypt('refresh-token-123', { connection: 'abc' });
    expect(sealed).not.toContain('refresh-token-123');
    expect(await kms.decrypt(sealed, { connection: 'abc' })).toBe('refresh-token-123');
  });

  it('uses a fresh data key per secret', async () => {
    const a = await kms.encrypt('same', { c: '1' });
    const b = await kms.encrypt('same', { c: '1' });
    expect(a).not.toBe(b);
  });

  it('refuses a different encryption context', async () => {
    const sealed = await kms.encrypt('secret', { connection: 'abc' });
    await expect(kms.decrypt(sealed, { connection: 'xyz' })).rejects.toThrow();
  });

  it('detects tampering', async () => {
    const sealed = await kms.encrypt('secret', { connection: 'abc' });
    const envelope = JSON.parse(Buffer.from(sealed, 'base64url').toString());
    envelope.ct = Buffer.from('tampered!').toString('base64');
    const forged = Buffer.from(JSON.stringify(envelope)).toString('base64url');
    await expect(kms.decrypt(forged, { connection: 'abc' })).rejects.toThrow();
  });
});

describe('config', () => {
  it('has working development defaults', () => {
    const config = loadConfig({});
    expect(config.auth.provider).toBe('dev');
    expect(config.business.defaultFeeBps).toBe(200);
    expect(config.business.holdTtlMinutes).toBe(15);
    expect(config.apaleo.redirectUri).toBe('http://localhost:4000/v1/integrations/apaleo/callback');
  });

  it('refuses to run production with development secrets', () => {
    expect(() => loadConfig({ APP_ENV: 'production' })).toThrow(ConfigError);
  });

  it('requires Cognito settings when Cognito is selected', () => {
    expect(() => loadConfig({ AUTH_PROVIDER: 'cognito' })).toThrow(/COGNITO_USER_POOL_ID/);
  });

  it('only enables LLM providers that have keys', () => {
    const config = loadConfig({ OPENAI_API_KEY: 'sk-test', ANTHROPIC_API_KEY: '' });
    expect(config.llm.openai?.apiKey).toBe('sk-test');
    expect(config.llm.anthropic).toBeUndefined();
  });
});

describe('email templates', () => {
  it('escapes user-controlled values', () => {
    expect(escapeHtml('<script>"x"</script>')).toBe('&lt;script&gt;&quot;x&quot;&lt;/script&gt;');
    const email = invitationEmail({
      organizationName: '<b>Evil</b> Hotels',
      inviterEmail: 'a@b.c',
      role: 'viewer',
      link: 'https://app.example/invite/abc',
    });
    expect(email.html).not.toContain('<b>Evil</b>');
    expect(email.text).toContain('https://app.example/invite/abc');
  });
});
