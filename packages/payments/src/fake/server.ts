import { createHmac, randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import qs from 'qs';

/**
 * An in-memory stand-in for the Stripe API, driven by the real `stripe` SDK (pointed at it with
 * host/port). It covers Connect accounts and onboarding links, manual-capture PaymentIntents with
 * application fees, customers and SetupIntents, platform invoices (Billing) with a hosted invoice
 * page, idempotency keys and signed webhooks. A browser-facing `/_fake/confirm` endpoint plays the
 * part of Stripe.js confirming a payment: it takes an outcome ("succeed" or "decline"), never card
 * data.
 */

export interface FakeStripeOptions {
  secretKey?: string;
  webhookSecret?: string;
  /** Where to deliver webhooks (our API's /webhooks/stripe). */
  webhookUrl?: string;
  /** Public base URL of this server (for onboarding links). */
  publicUrl?: string;
}

type Obj = Record<string, unknown> & { id: string };

interface FakeStripeState {
  accounts: Map<string, Obj>;
  objects: Map<string, Obj & { _account: string | null }>;
  events: { id: string; type: string; account: string | null; delivered: number | null }[];
  failNext: Map<string, { status: number; message: string }>;
  requests: { method: string; url: string; account: string | null; idempotencyKey: string | null }[];
}

const id = (prefix: string) => `${prefix}_${randomBytes(12).toString('base64url').replace(/[-_]/g, '')}`;
const now = () => Math.floor(Date.now() / 1000);
const CURRENCY_BY_COUNTRY: Record<string, string> = { US: 'usd', GB: 'gbp', CH: 'chf' };

export function createFakeStripe(options: FakeStripeOptions = {}) {
  const secretKey = options.secretKey ?? 'sk_test_lodgent_fake';
  const webhookSecret = options.webhookSecret ?? 'whsec_lodgent_fake_0123456789abcdef';
  const state: FakeStripeState = {
    accounts: new Map(),
    objects: new Map(),
    events: [],
    failNext: new Map(),
    requests: [],
  };
  const idempotency = new Map<string, { status: number; body: unknown }>();
  let webhookUrl = options.webhookUrl;
  let publicUrl = options.publicUrl ?? '';

  const app: FastifyInstance = Fastify({ logger: false });
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, qs.parse(body as string, { depth: 10, arrayLimit: 100 }));
  });

  // Browser-facing endpoints (the simulated Stripe.js) need CORS.
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/_fake/')) {
      reply.header('access-control-allow-origin', '*');
      reply.header('access-control-allow-headers', 'content-type');
      reply.header('access-control-allow-methods', 'GET,POST,OPTIONS');
    }
  });
  app.options('/_fake/*', async (_req, reply) => reply.status(204).send());

  const accountOf = (req: FastifyRequest): string | null => {
    const header = req.headers['stripe-context'] ?? req.headers['stripe-account'];
    return typeof header === 'string' && header.length > 0 ? header : null;
  };

  const stripeError = (
    reply: FastifyReply,
    status: number,
    message: string,
    code?: string,
    type = 'invalid_request_error',
  ) => reply.status(status).send({ error: { type, message, ...(code ? { code } : {}) } });

  function authorize(req: FastifyRequest, reply: FastifyReply): boolean {
    const auth = req.headers.authorization ?? '';
    if (auth !== `Bearer ${secretKey}`) {
      stripeError(reply, 401, 'Invalid API Key provided');
      return false;
    }
    return true;
  }

  /** Runs a mutating handler once per (account, Idempotency-Key). */
  async function idempotent(
    req: FastifyRequest,
    reply: FastifyReply,
    operation: string,
    fn: () => Promise<[number, unknown]> | [number, unknown],
  ) {
    if (!authorize(req, reply)) return reply;
    const account = accountOf(req);
    const key = req.headers['idempotency-key'];
    state.requests.push({
      method: req.method,
      url: req.url,
      account,
      idempotencyKey: typeof key === 'string' ? key : null,
    });
    const failure = state.failNext.get(operation);
    if (failure) {
      state.failNext.delete(operation);
      return stripeError(
        reply,
        failure.status,
        failure.message,
        undefined,
        failure.status >= 500 ? 'api_error' : 'invalid_request_error',
      );
    }
    const cacheKey = typeof key === 'string' ? `${account ?? 'platform'}:${key}` : null;
    if (cacheKey && idempotency.has(cacheKey)) {
      const cached = idempotency.get(cacheKey)!;
      reply.header('idempotent-replayed', 'true');
      return reply.status(cached.status).send(cached.body);
    }
    const [status, body] = await fn();
    if (cacheKey) idempotency.set(cacheKey, { status, body });
    return reply.status(status).send(body);
  }

  function publicObject(o: Obj & { _account?: string | null }): Obj {
    const { _account, ...rest } = o;
    return rest as Obj;
  }

  function findOwned(req: FastifyRequest, objectId: string) {
    const o = state.objects.get(objectId);
    if (!o || o._account !== accountOf(req)) return null;
    return o;
  }

  async function emit(type: string, object: Obj, account: string | null) {
    const event = {
      id: id('evt'),
      object: 'event',
      api_version: '2026-09-30.endive',
      created: now(),
      type,
      account: account ?? undefined,
      livemode: false,
      data: { object: publicObject(object) },
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
    };
    const record = { id: event.id, type, account, delivered: null as number | null };
    state.events.push(record);
    if (!webhookUrl) return;
    const payload = JSON.stringify(event);
    const t = now();
    const signature = createHmac('sha256', webhookSecret).update(`${t}.${payload}`).digest('hex');
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${signature}` },
        body: payload,
      });
      record.delivered = res.status;
    } catch {
      record.delivered = 0;
    }
  }

  // ---- Connect -------------------------------------------------------------------------------
  app.post('/v1/accounts', (req, reply) =>
    idempotent(req, reply, 'accounts.create', () => {
      const body = req.body as Record<string, unknown>;
      const country = typeof body.country === 'string' ? body.country : 'PT';
      const account: Obj = {
        id: id('acct'),
        object: 'account',
        email: body.email ?? null,
        country,
        default_currency: CURRENCY_BY_COUNTRY[country] ?? 'eur',
        charges_enabled: false,
        payouts_enabled: false,
        details_submitted: false,
        controller: body.controller ?? null,
        metadata: body.metadata ?? {},
        requirements: {
          currently_due: ['business_profile.url', 'external_account', 'tos_acceptance.date'],
          past_due: [],
        },
        created: now(),
      };
      state.accounts.set(account.id, account);
      return [200, account];
    }),
  );

  app.get('/v1/accounts/:id', async (req, reply) => {
    if (!authorize(req, reply)) return reply;
    const account = state.accounts.get((req.params as { id: string }).id);
    return account ? account : stripeError(reply, 404, 'No such account', 'resource_missing');
  });

  app.post('/v1/account_links', (req, reply) =>
    idempotent(req, reply, 'account_links.create', () => {
      const body = req.body as { account?: string; return_url?: string; refresh_url?: string };
      if (!body.account || !state.accounts.has(body.account))
        return [404, { error: { type: 'invalid_request_error', message: 'No such account' } }];
      const url = `${publicUrl}/_fake/onboarding/${body.account}?${new URLSearchParams({
        return_url: body.return_url ?? '',
        refresh_url: body.refresh_url ?? '',
      })}`;
      return [200, { object: 'account_link', url, created: now(), expires_at: now() + 300 }];
    }),
  );

  /** Simulated hosted onboarding. */
  app.get('/_fake/onboarding/:account', async (req, reply) => {
    const accountId = (req.params as { account: string }).account;
    const q = req.query as Record<string, string>;
    if (!state.accounts.has(accountId)) return reply.status(404).send('Unknown account');
    const done = `/_fake/onboarding/${accountId}/complete?${new URLSearchParams({ return_url: q.return_url ?? '' })}`;
    return reply
      .type('text/html')
      .send(`<!doctype html><html><body style="font-family:system-ui;max-width:440px;margin:60px auto">
<h1>Fake Stripe onboarding</h1><p>In real Stripe the hotel would enter business, identity and bank details here.</p>
<p><a id="complete" href="${done}">Complete onboarding (test)</a></p></body></html>`);
  });

  app.get('/_fake/onboarding/:account/complete', async (req, reply) => {
    const accountId = (req.params as { account: string }).account;
    const account = state.accounts.get(accountId);
    if (!account) return reply.status(404).send('Unknown account');
    Object.assign(account, {
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
      requirements: { currently_due: [], past_due: [] },
    });
    await emit('account.updated', account, accountId);
    return reply.redirect((req.query as Record<string, string>).return_url || '/');
  });

  // ---- Payments ------------------------------------------------------------------------------
  const requireConnected = (req: FastifyRequest) => {
    const account = accountOf(req);
    const a = account ? state.accounts.get(account) : null;
    return a ?? null;
  };

  app.post('/v1/payment_intents', (req, reply) =>
    idempotent(req, reply, 'payment_intents.create', () => {
      const account = requireConnected(req);
      if (!account)
        return [400, { error: { type: 'invalid_request_error', message: 'Unknown connected account' } }];
      if (!account.charges_enabled) {
        return [
          400,
          {
            error: {
              type: 'invalid_request_error',
              message: 'Account cannot accept charges yet',
              code: 'account_invalid',
            },
          },
        ];
      }
      const body = req.body as Record<string, unknown>;
      const amount = Number(body.amount);
      const fee = body.application_fee_amount !== undefined ? Number(body.application_fee_amount) : null;
      if (!Number.isInteger(amount) || amount < 50)
        return [400, { error: { type: 'invalid_request_error', message: 'Invalid amount' } }];
      if (fee !== null && fee > amount)
        return [400, { error: { type: 'invalid_request_error', message: 'Fee exceeds amount' } }];
      const piId = id('pi');
      const pi = {
        id: piId,
        object: 'payment_intent',
        amount,
        amount_capturable: 0,
        amount_received: 0,
        currency: String(body.currency),
        capture_method: body.capture_method ?? 'automatic_async',
        application_fee_amount: fee,
        automatic_payment_methods: body.automatic_payment_methods ?? null,
        client_secret: `${piId}_secret_${randomBytes(12).toString('hex')}`,
        description: body.description ?? null,
        metadata: body.metadata ?? {},
        receipt_email: body.receipt_email ?? null,
        status: 'requires_payment_method',
        last_payment_error: null,
        created: now(),
        _account: account.id as string,
      };
      state.objects.set(piId, pi);
      return [200, publicObject(pi)];
    }),
  );

  app.get('/v1/payment_intents/:id', async (req, reply) => {
    if (!authorize(req, reply)) return reply;
    const pi = findOwned(req, (req.params as { id: string }).id);
    return pi ? publicObject(pi) : stripeError(reply, 404, 'No such payment_intent', 'resource_missing');
  });

  app.post('/v1/payment_intents/:id/capture', (req, reply) =>
    idempotent(req, reply, 'payment_intents.capture', async () => {
      const pi = findOwned(req, (req.params as { id: string }).id);
      if (!pi) return [404, { error: { type: 'invalid_request_error', message: 'No such payment_intent' } }];
      if (pi.status !== 'requires_capture') {
        return [
          400,
          {
            error: {
              type: 'invalid_request_error',
              code: 'payment_intent_unexpected_state',
              message: `This PaymentIntent could not be captured because it has a status of ${pi.status}.`,
            },
          },
        ];
      }
      Object.assign(pi, { status: 'succeeded', amount_received: pi.amount, amount_capturable: 0 });
      await emit('payment_intent.succeeded', pi, pi._account);
      return [200, publicObject(pi)];
    }),
  );

  app.post('/v1/payment_intents/:id/cancel', (req, reply) =>
    idempotent(req, reply, 'payment_intents.cancel', async () => {
      const pi = findOwned(req, (req.params as { id: string }).id);
      if (!pi) return [404, { error: { type: 'invalid_request_error', message: 'No such payment_intent' } }];
      if (pi.status === 'succeeded' || pi.status === 'canceled') {
        return [
          400,
          {
            error: {
              type: 'invalid_request_error',
              code: 'payment_intent_unexpected_state',
              message: `You cannot cancel this PaymentIntent because it has a status of ${pi.status}.`,
            },
          },
        ];
      }
      Object.assign(pi, { status: 'canceled', amount_capturable: 0 });
      await emit('payment_intent.canceled', pi, pi._account);
      return [200, publicObject(pi)];
    }),
  );

  app.post('/v1/customers', (req, reply) =>
    idempotent(req, reply, 'customers.create', () => {
      // Customers live on a connected account (guests' saved cards) or on the platform (billing).
      const account = requireConnected(req);
      if (!account && accountOf(req))
        return [400, { error: { type: 'invalid_request_error', message: 'Unknown connected account' } }];
      const body = req.body as Record<string, unknown>;
      const customer = {
        id: id('cus'),
        object: 'customer',
        email: body.email ?? null,
        name: body.name ?? null,
        metadata: body.metadata ?? {},
        _account: account ? (account.id as string) : null,
      };
      state.objects.set(customer.id, customer);
      return [200, publicObject(customer)];
    }),
  );

  app.post('/v1/setup_intents', (req, reply) =>
    idempotent(req, reply, 'setup_intents.create', () => {
      const account = requireConnected(req);
      if (!account)
        return [400, { error: { type: 'invalid_request_error', message: 'Unknown connected account' } }];
      const body = req.body as Record<string, unknown>;
      const siId = id('seti');
      const si = {
        id: siId,
        object: 'setup_intent',
        customer: body.customer ?? null,
        usage: body.usage ?? 'off_session',
        client_secret: `${siId}_secret_${randomBytes(12).toString('hex')}`,
        description: body.description ?? null,
        metadata: body.metadata ?? {},
        payment_method: null,
        status: 'requires_payment_method',
        last_setup_error: null,
        created: now(),
        _account: account.id as string,
      };
      state.objects.set(siId, si);
      return [200, publicObject(si)];
    }),
  );

  app.get('/v1/setup_intents/:id', async (req, reply) => {
    if (!authorize(req, reply)) return reply;
    const si = findOwned(req, (req.params as { id: string }).id);
    return si ? publicObject(si) : stripeError(reply, 404, 'No such setup_intent', 'resource_missing');
  });

  // ---- Billing (platform invoices) -----------------------------------------------------------
  let invoiceCounter = 0;
  const invalid = (message: string, status = 400): [number, unknown] => [
    status,
    { error: { type: 'invalid_request_error', message } },
  ];
  const recalc = (inv: Obj) => {
    const lines = inv.lines as { data: { amount: number }[] };
    const total = lines.data.reduce((sum, l) => sum + l.amount, 0);
    Object.assign(inv, {
      subtotal: total,
      total,
      amount_due: total,
      amount_remaining: total - Number(inv.amount_paid),
    });
  };

  app.post('/v1/invoices', (req, reply) =>
    idempotent(req, reply, 'invoices.create', () => {
      const body = req.body as Record<string, unknown>;
      const customer = findOwned(req, String(body.customer ?? ''));
      if (customer?.object !== 'customer') return invalid('No such customer', 404);
      const invId = id('in');
      const inv = {
        id: invId,
        object: 'invoice',
        customer: customer.id,
        currency: String(body.currency ?? 'eur'),
        collection_method: body.collection_method ?? 'charge_automatically',
        days_until_due: body.days_until_due !== undefined ? Number(body.days_until_due) : null,
        auto_advance: body.auto_advance === 'true',
        description: body.description ?? null,
        metadata: body.metadata ?? {},
        status: 'draft',
        number: null,
        lines: { object: 'list', data: [] as Obj[], has_more: false },
        subtotal: 0,
        total: 0,
        amount_due: 0,
        amount_paid: 0,
        amount_remaining: 0,
        hosted_invoice_url: null,
        invoice_pdf: null,
        due_date: null,
        status_transitions: { finalized_at: null, paid_at: null, voided_at: null },
        created: now(),
        _account: accountOf(req),
      };
      state.objects.set(invId, inv);
      return [200, publicObject(inv)];
    }),
  );

  app.post('/v1/invoiceitems', (req, reply) =>
    idempotent(req, reply, 'invoiceitems.create', () => {
      const body = req.body as Record<string, unknown>;
      const inv = findOwned(req, String(body.invoice ?? ''));
      if (inv?.object !== 'invoice') return invalid('No such invoice', 404);
      if (inv.status !== 'draft') return invalid('Invoice is not a draft');
      const amount = Number(body.amount);
      if (!Number.isInteger(amount)) return invalid('Invalid amount');
      const item = {
        id: id('ii'),
        object: 'invoiceitem',
        invoice: inv.id,
        customer: body.customer,
        amount,
        currency: String(body.currency ?? inv.currency),
        description: body.description ?? null,
        _account: accountOf(req),
      };
      state.objects.set(item.id, item);
      (inv.lines as { data: Obj[] }).data.push({
        id: id('il'),
        object: 'line_item',
        amount,
        currency: item.currency,
        description: item.description,
      });
      recalc(inv);
      return [200, publicObject(item)];
    }),
  );

  app.get('/v1/invoices/:id', async (req, reply) => {
    if (!authorize(req, reply)) return reply;
    const inv = findOwned(req, (req.params as { id: string }).id);
    return inv?.object === 'invoice'
      ? publicObject(inv)
      : stripeError(reply, 404, 'No such invoice', 'resource_missing');
  });

  app.post('/v1/invoices/:id/finalize', (req, reply) =>
    idempotent(req, reply, 'invoices.finalize', async () => {
      const inv = findOwned(req, (req.params as { id: string }).id);
      if (inv?.object !== 'invoice') return invalid('No such invoice', 404);
      if (inv.status !== 'draft') return invalid(`Invoice is already ${inv.status}`);
      invoiceCounter++;
      Object.assign(inv, {
        status: 'open',
        number: `LODG-${String(invoiceCounter).padStart(4, '0')}`,
        hosted_invoice_url: `${publicUrl}/_fake/invoices/${inv.id}`,
        invoice_pdf: `${publicUrl}/_fake/invoices/${inv.id}/pdf`,
        due_date: inv.days_until_due !== null ? now() + Number(inv.days_until_due) * 86_400 : null,
        status_transitions: { ...(inv.status_transitions as object), finalized_at: now() },
      });
      await emit('invoice.finalized', inv, inv._account);
      return [200, publicObject(inv)];
    }),
  );

  app.post('/v1/invoices/:id/send', (req, reply) =>
    idempotent(req, reply, 'invoices.send', async () => {
      const inv = findOwned(req, (req.params as { id: string }).id);
      if (inv?.object !== 'invoice') return invalid('No such invoice', 404);
      if (inv.status !== 'open') return invalid('Only open invoices can be sent');
      await emit('invoice.sent', inv, inv._account);
      return [200, publicObject(inv)];
    }),
  );

  app.post('/v1/invoices/:id/void', (req, reply) =>
    idempotent(req, reply, 'invoices.void', async () => {
      const inv = findOwned(req, (req.params as { id: string }).id);
      if (inv?.object !== 'invoice') return invalid('No such invoice', 404);
      if (inv.status !== 'open') return invalid('Only open invoices can be voided');
      Object.assign(inv, {
        status: 'void',
        status_transitions: { ...(inv.status_transitions as object), voided_at: now() },
      });
      await emit('invoice.voided', inv, inv._account);
      return [200, publicObject(inv)];
    }),
  );

  async function payInvoice(invoiceId: string): Promise<Obj | null> {
    const inv = state.objects.get(invoiceId);
    if (inv?.object !== 'invoice' || inv.status !== 'open') return null;
    Object.assign(inv, {
      status: 'paid',
      amount_paid: inv.amount_due,
      amount_remaining: 0,
      status_transitions: { ...(inv.status_transitions as object), paid_at: now() },
    });
    await emit('invoice.paid', inv, inv._account);
    return inv;
  }

  /** Simulated hosted invoice page (the hotel pays the platform's fee invoice here). */
  app.get('/_fake/invoices/:id', async (req, reply) => {
    const inv = state.objects.get((req.params as { id: string }).id);
    if (inv?.object !== 'invoice') return reply.status(404).send('Unknown invoice');
    const esc = (v: unknown) =>
      String(v ?? '').replace(
        /[&<>"]/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!,
      );
    const money = (n: number) => `${(n / 100).toFixed(2)} ${String(inv.currency).toUpperCase()}`;
    const lines = (inv.lines as { data: { amount: number; description: string | null }[] }).data
      .map(
        (l) => `<tr><td>${esc(l.description)}</td><td style="text-align:right">${money(l.amount)}</td></tr>`,
      )
      .join('');
    const action =
      inv.status === 'open'
        ? `<form method="post" action="/_fake/invoices/${inv.id}/pay"><button id="pay" type="submit">Pay invoice (test)</button></form>`
        : `<p id="status">Status: ${esc(inv.status)}</p>`;
    return reply
      .type('text/html')
      .send(`<!doctype html><html><body style="font-family:system-ui;max-width:560px;margin:60px auto">
<h1>Invoice ${esc(inv.number)}</h1><p>${esc(inv.description)}</p>
<table style="width:100%">${lines}<tr><th style="text-align:left">Total</th><th style="text-align:right">${money(Number(inv.amount_due))}</th></tr></table>
${action}</body></html>`);
  });

  app.post('/_fake/invoices/:id/pay', async (req, reply) => {
    const invoiceId = (req.params as { id: string }).id;
    const inv = await payInvoice(invoiceId);
    if (!inv) return reply.status(400).send('Invoice cannot be paid');
    return reply.redirect(`/_fake/invoices/${invoiceId}`, 303);
  });

  // ---- Simulated Stripe.js -------------------------------------------------------------------
  /** Confirms an intent by client secret, as Stripe.js would after the customer entered a card. */
  app.post('/_fake/confirm', async (req, reply) => {
    const body = req.body as { client_secret?: string; outcome?: 'succeed' | 'decline' };
    const target = [...state.objects.values()].find((o) => o.client_secret === body.client_secret);
    if (!target) return stripeError(reply, 404, 'No intent with that client secret');
    const decline = body.outcome === 'decline';
    if (target.object === 'payment_intent') {
      if (target.status !== 'requires_payment_method' && target.status !== 'requires_confirmation') {
        return stripeError(
          reply,
          400,
          `Cannot confirm a PaymentIntent with status ${target.status}`,
          'payment_intent_unexpected_state',
        );
      }
      if (decline) {
        Object.assign(target, {
          status: 'requires_payment_method',
          last_payment_error: {
            type: 'card_error',
            code: 'card_declined',
            message: 'Your card was declined.',
          },
        });
        await emit('payment_intent.payment_failed', target, target._account);
        return { error: { type: 'card_error', code: 'card_declined', message: 'Your card was declined.' } };
      }
      const manual = target.capture_method === 'manual';
      Object.assign(target, {
        status: manual ? 'requires_capture' : 'succeeded',
        amount_capturable: manual ? target.amount : 0,
        amount_received: manual ? 0 : target.amount,
        last_payment_error: null,
      });
      await emit(
        manual ? 'payment_intent.amount_capturable_updated' : 'payment_intent.succeeded',
        target,
        target._account,
      );
      return { paymentIntent: { id: target.id, status: target.status } };
    }
    if (target.object === 'setup_intent') {
      if (decline) {
        Object.assign(target, {
          status: 'requires_payment_method',
          last_setup_error: { type: 'card_error', code: 'card_declined', message: 'Your card was declined.' },
        });
        await emit('setup_intent.setup_failed', target, target._account);
        return { error: { type: 'card_error', code: 'card_declined', message: 'Your card was declined.' } };
      }
      Object.assign(target, { status: 'succeeded', payment_method: id('pm'), last_setup_error: null });
      await emit('setup_intent.succeeded', target, target._account);
      return { setupIntent: { id: target.id, status: target.status } };
    }
    return stripeError(reply, 400, 'Unsupported object');
  });

  // ---- Test controls -------------------------------------------------------------------------
  app.post('/_fake/fail-next', async (req) => {
    const { operation, status, message } = req.body as {
      operation: string;
      status?: number;
      message?: string;
    };
    state.failNext.set(operation, {
      status: status ?? 500,
      message: message ?? `Simulated failure of ${operation}`,
    });
    return { ok: true };
  });
  app.post('/_fake/reset', async () => {
    state.accounts.clear();
    state.objects.clear();
    state.events.length = 0;
    state.failNext.clear();
    state.requests.length = 0;
    idempotency.clear();
    return { ok: true };
  });
  app.get('/_fake/health', async () => ({ ok: true }));

  return {
    app,
    state,
    setWebhookUrl(url: string | undefined) {
      webhookUrl = url;
    },
    setPublicUrl(url: string) {
      publicUrl = url;
    },
    /** Confirms an intent directly (tests), as the browser would via /_fake/confirm. */
    async confirm(clientSecret: string, outcome: 'succeed' | 'decline' = 'succeed') {
      const res = await app.inject({
        method: 'POST',
        url: '/_fake/confirm',
        payload: { client_secret: clientSecret, outcome },
      });
      return res.json() as Record<string, unknown>;
    },
    /** Pays an open platform invoice, as the hotel would on the hosted invoice page (tests). */
    payInvoice,
    /** Marks a connected account as fully onboarded (tests). */
    async completeOnboarding(accountId: string) {
      await app.inject({ method: 'GET', url: `/_fake/onboarding/${accountId}/complete?return_url=/` });
    },
  };
}

export type FakeStripe = ReturnType<typeof createFakeStripe>;
