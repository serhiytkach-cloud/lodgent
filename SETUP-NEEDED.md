# Setup needed

Everything runs locally without any of these: `pnpm dev` uses a fake Apaleo, a fake Stripe, fixture LLM
providers, Mailpit and a dev sign-in. This is the list of real accounts and keys needed to go live.
It is kept up to date as integrations land.

| # | What | Why | Where it goes |
| --- | --- | --- | --- |
| 1 | GitHub repository `lodgent` with the Claude GitHub App installed | Push code, run CI | github.com |
| 2 | **Apaleo developer account + "connected app" (store app) registration**: client id/secret, redirect URI `<API_BASE_URL>/v1/integrations/apaleo/callback`, scopes `offline_access setup.read rates.read availability.read reservations.manage folios.manage` plus the scope Apaleo requires for webhook subscriptions (check apaleo.dev → API scopes; set `APALEO_SCOPES` if it differs) | Hotels connect their Apaleo account; live rates and reservations | `APALEO_CLIENT_ID`, `APALEO_CLIENT_SECRET`, `APALEO_SCOPES`, URLs `https://identity.apaleo.com`, `https://api.apaleo.com`, `https://webhook.apaleo.com` |
| 3 | An **Apaleo sandbox/test account** with at least one property whose rate plans are distributed on the `Ibe` channel | Verify the all-in price calculation (ADR 0006) and the end-to-end booking | Connect it from the dashboard |
| 4 | A random `APALEO_WEBHOOK_TOKEN` and `SIGNING_SECRET` (32+ bytes each) | Webhook endpoint secret, signed OAuth state / checkout links | Secrets Manager (see infra) |
