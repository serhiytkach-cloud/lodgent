export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}

export interface Mailer {
  send(message: EmailMessage): Promise<{ messageId: string }>;
}

export interface QueuedJob {
  type: string;
  payload: Record<string, unknown>;
  /** Jobs with the same key are only enqueued once (best effort on SQS: message deduplication window). */
  dedupeKey?: string;
  delaySeconds?: number;
}

/** Background job queue (SQS in AWS, a Postgres table locally). */
export interface JobQueue {
  enqueue(job: QueuedJob): Promise<void>;
}

/** Envelope encryption for secrets at rest (PMS OAuth tokens). */
export interface KeyManagement {
  encrypt(plaintext: string, context: Record<string, string>): Promise<string>;
  decrypt(ciphertext: string, context: Record<string, string>): Promise<string>;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
