import { redactUrl } from '@lodgent/application';
import type { FastifyInstance } from 'fastify';

/** Luhn checksum, used by every payment card number. */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

const CANDIDATE = /(?:\d[ -]?){12,18}\d/g;
/** Identifiers and timestamps that contain long digit runs but are never card numbers. */
const NOT_CARDS = [
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
  /\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?/g,
];
/** Issuer prefixes of the major card networks (Visa, Mastercard, Amex, Discover, JCB, Diners, UnionPay, Maestro). */
const CARD_PREFIX = /^(?:4|5[1-5]|2[2-7]|3[47]|3[0689]|35|6(?:011|5|4[4-9]|2)|5[06-8]|6\d)/;

/** True if the text contains something that looks like a payment card number (prefix, length and Luhn). */
export function containsCardNumber(text: string): boolean {
  let cleaned = text;
  for (const pattern of NOT_CARDS) cleaned = cleaned.replace(pattern, ' ');
  for (const match of cleaned.match(CANDIDATE) ?? []) {
    const digits = match.replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && CARD_PREFIX.test(digits) && luhnValid(digits))
      return true;
  }
  return false;
}

/**
 * Defense in depth for "never accept card data": any request body (REST or MCP tool arguments)
 * carrying a card-number-like value is rejected before it is parsed or logged. Webhooks from the
 * payment provider are exempt (they carry provider objects, never full card numbers).
 */
export function registerCardDataGuard(server: FastifyInstance): void {
  server.addHook('preValidation', async (req, reply) => {
    if (!req.rawBody || req.url.startsWith('/webhooks/')) return;
    if (containsCardNumber(req.rawBody.toString('utf8'))) {
      req.log.warn({ url: redactUrl(req.url) }, 'rejected a request containing card-like data');
      return reply.status(400).send({
        error: {
          code: 'card_data_rejected',
          message:
            'Payment card details are never accepted here. Guests pay on the secure checkout page returned by create_hold.',
        },
      });
    }
  });
}
