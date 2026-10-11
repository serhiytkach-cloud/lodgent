import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import type { EmailMessage, Mailer } from '@lodgent/core';
import nodemailer from 'nodemailer';

/** SMTP mailer; locally this points at Mailpit (http://localhost:8025). */
export class SmtpMailer implements Mailer {
  private readonly transport;

  constructor(
    smtpUrl: string,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport(smtpUrl);
  }

  async send(message: EmailMessage): Promise<{ messageId: string }> {
    const info = await this.transport.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
      replyTo: message.replyTo,
    });
    return { messageId: String(info.messageId) };
  }
}

export class SesMailer implements Mailer {
  constructor(
    private readonly client: SESv2Client,
    private readonly from: string,
  ) {}

  static create(options: { region: string; endpoint?: string; from: string }): SesMailer {
    return new SesMailer(
      new SESv2Client({ region: options.region, endpoint: options.endpoint }),
      options.from,
    );
  }

  async send(message: EmailMessage): Promise<{ messageId: string }> {
    const result = await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: this.from,
        Destination: { ToAddresses: [message.to] },
        ReplyToAddresses: message.replyTo ? [message.replyTo] : undefined,
        Content: {
          Simple: {
            Subject: { Data: message.subject, Charset: 'UTF-8' },
            Body: {
              Html: { Data: message.html, Charset: 'UTF-8' },
              Text: { Data: message.text, Charset: 'UTF-8' },
            },
          },
        },
      }),
    );
    return { messageId: result.MessageId ?? 'unknown' };
  }
}

/** Collects messages in memory; used by tests. */
export class MemoryMailer implements Mailer {
  readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<{ messageId: string }> {
    this.sent.push(message);
    return { messageId: `memory-${this.sent.length}` };
  }
}
