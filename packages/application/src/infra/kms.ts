import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { DecryptCommand, GenerateDataKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import type { KeyManagement } from '@lodgent/core';
import { z } from 'zod';

/**
 * Envelope encryption. Each secret gets a fresh 256-bit data key; the payload is sealed with
 * AES-256-GCM (the encryption context is bound as additional authenticated data) and only the
 * data key is wrapped by the master key (AWS KMS in production, a local key in development).
 */
const Envelope = z.object({
  v: z.literal(1),
  kms: z.enum(['local', 'aws']),
  edk: z.string(),
  iv: z.string(),
  tag: z.string(),
  ct: z.string(),
});
type Envelope = z.infer<typeof Envelope>;

function aad(context: Record<string, string>): Buffer {
  const sorted = Object.keys(context)
    .sort()
    .map((k) => [k, context[k]]);
  return Buffer.from(JSON.stringify(sorted));
}

function seal(key: Buffer, plaintext: Buffer, additional: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(additional);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, ct, tag: cipher.getAuthTag() };
}

function open(key: Buffer, iv: Buffer, ct: Buffer, tag: Buffer, additional: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(additional);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

function encode(envelope: Envelope): string {
  return Buffer.from(JSON.stringify(envelope)).toString('base64url');
}

function decode(ciphertext: string): Envelope {
  return Envelope.parse(JSON.parse(Buffer.from(ciphertext, 'base64url').toString('utf8')));
}

function sealWithDataKey(
  kms: Envelope['kms'],
  dataKey: Buffer,
  edk: Buffer,
  plaintext: string,
  context: Record<string, string>,
) {
  const { iv, ct, tag } = seal(dataKey, Buffer.from(plaintext, 'utf8'), aad(context));
  return encode({
    v: 1,
    kms,
    edk: edk.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ct.toString('base64'),
  });
}

function openWithDataKey(envelope: Envelope, dataKey: Buffer, context: Record<string, string>): string {
  return open(
    dataKey,
    Buffer.from(envelope.iv, 'base64'),
    Buffer.from(envelope.ct, 'base64'),
    Buffer.from(envelope.tag, 'base64'),
    aad(context),
  ).toString('utf8');
}

export class LocalKeyManagement implements KeyManagement {
  private readonly masterKey: Buffer;

  constructor(masterKeyBase64: string) {
    this.masterKey = Buffer.from(masterKeyBase64, 'base64');
    if (this.masterKey.length !== 32)
      throw new Error('LOCAL_KMS_MASTER_KEY must be 32 bytes, base64-encoded');
  }

  async encrypt(plaintext: string, context: Record<string, string>): Promise<string> {
    const dataKey = randomBytes(32);
    const wrapped = seal(this.masterKey, dataKey, aad(context));
    const edk = Buffer.concat([wrapped.iv, wrapped.tag, wrapped.ct]);
    return sealWithDataKey('local', dataKey, edk, plaintext, context);
  }

  async decrypt(ciphertext: string, context: Record<string, string>): Promise<string> {
    const envelope = decode(ciphertext);
    if (envelope.kms !== 'local') throw new Error('Ciphertext was not produced by the local key manager');
    const edk = Buffer.from(envelope.edk, 'base64');
    const dataKey = open(
      this.masterKey,
      edk.subarray(0, 12),
      edk.subarray(28),
      edk.subarray(12, 28),
      aad(context),
    );
    return openWithDataKey(envelope, dataKey, context);
  }
}

export class AwsKeyManagement implements KeyManagement {
  constructor(
    private readonly client: KMSClient,
    private readonly keyId: string,
  ) {}

  static create(options: { keyId: string; region: string; endpoint?: string }): AwsKeyManagement {
    return new AwsKeyManagement(
      new KMSClient({ region: options.region, endpoint: options.endpoint }),
      options.keyId,
    );
  }

  async encrypt(plaintext: string, context: Record<string, string>): Promise<string> {
    const result = await this.client.send(
      new GenerateDataKeyCommand({ KeyId: this.keyId, KeySpec: 'AES_256', EncryptionContext: context }),
    );
    if (!result.Plaintext || !result.CiphertextBlob) throw new Error('KMS GenerateDataKey returned no key');
    const dataKey = Buffer.from(result.Plaintext);
    try {
      return sealWithDataKey('aws', dataKey, Buffer.from(result.CiphertextBlob), plaintext, context);
    } finally {
      dataKey.fill(0);
    }
  }

  async decrypt(ciphertext: string, context: Record<string, string>): Promise<string> {
    const envelope = decode(ciphertext);
    if (envelope.kms !== 'aws') throw new Error('Ciphertext was not produced by AWS KMS');
    const result = await this.client.send(
      new DecryptCommand({ CiphertextBlob: Buffer.from(envelope.edk, 'base64'), EncryptionContext: context }),
    );
    if (!result.Plaintext) throw new Error('KMS Decrypt returned no key');
    const dataKey = Buffer.from(result.Plaintext);
    try {
      return openWithDataKey(envelope, dataKey, context);
    } finally {
      dataKey.fill(0);
    }
  }
}
