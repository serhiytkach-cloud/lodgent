import { BRAND, type PaymentAccountDto } from '@lodgent/shared';
import { CreditCard, PlugZap, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, Badge, PageHeader } from '@/components/ui/misc';
import { api } from '@/lib/api';
import type { Organization } from '@/lib/types';
import { formatDateTime } from '@/lib/utils';
import { connectApaleo, connectStripe, disconnectApaleo, refreshStripe, syncApaleo } from './actions';

interface ApaleoStatus {
  connected: boolean;
  accountCode: string | null;
  accountName: string | null;
  status: 'active' | 'error' | 'revoked' | null;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  lastSyncStats: Record<string, number> | null;
  webhooksActive: boolean;
}

const MESSAGES: Record<string, { variant: 'success' | 'error' | 'warning'; text: string }> = {
  connected: {
    variant: 'success',
    text: 'Apaleo is connected. We’re importing your properties now; this takes a few seconds.',
  },
  denied: { variant: 'warning', text: 'You declined access in Apaleo. Nothing was connected.' },
  error: { variant: 'error', text: 'Connecting Apaleo failed. Please try again.' },
  expired: { variant: 'error', text: 'The connection link expired. Please start again.' },
  forbidden: { variant: 'error', text: 'Only owners and admins can connect Apaleo.' },
  pms_account_in_use: {
    variant: 'error',
    text: 'That Apaleo account is already connected to another organization.',
  },
};

export default async function ConnectionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ apaleo?: string; welcome?: string; stripe?: string }>;
}) {
  const { orgId } = await params;
  const query = await searchParams;
  // Coming back from Stripe's hosted onboarding: read the account's new state first.
  if (query.stripe === 'return') {
    await api(`/v1/orgs/${orgId}/payments/refresh`, { method: 'POST' }).catch(() => undefined);
  }
  const [org, apaleo, stripe] = await Promise.all([
    api<Organization>(`/v1/orgs/${orgId}`),
    api<ApaleoStatus>(`/v1/orgs/${orgId}/integrations/apaleo`),
    api<PaymentAccountDto>(`/v1/orgs/${orgId}/payments`),
  ]);
  const isOwner = org.role === 'owner';
  const canManage = org.role !== 'viewer';
  const message = query.apaleo ? (MESSAGES[query.apaleo] ?? MESSAGES.error) : undefined;

  return (
    <>
      <PageHeader
        title="Connections"
        description="Connect your PMS so agents get live rates, and Stripe so guests can pay you directly."
      />
      {query.welcome ? (
        <Alert variant="info" className="mb-4" title="Welcome! Start by connecting Apaleo.">
          We import your properties, room types and rate plans. Nothing is published to agents until you
          review and publish.
        </Alert>
      ) : null}
      {message ? (
        <Alert variant={message.variant} className="mb-4">
          {message.text}
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Apaleo PMS</CardTitle>
              {apaleo.connected ? (
                <Badge variant={apaleo.status === 'error' ? 'destructive' : 'success'}>
                  {apaleo.status === 'error' ? 'Needs attention' : 'Connected'}
                </Badge>
              ) : (
                <Badge variant="secondary">Not connected</Badge>
              )}
            </div>
            <CardDescription>
              Properties, room types, rate plans, live availability and reservations.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {apaleo.connected ? (
              <>
                <dl className="grid grid-cols-2 gap-2 text-sm">
                  <dt className="text-muted-foreground">Account</dt>
                  <dd>
                    {apaleo.accountName} ({apaleo.accountCode})
                  </dd>
                  <dt className="text-muted-foreground">Last import</dt>
                  <dd>
                    {apaleo.lastSyncAt ? formatDateTime(apaleo.lastSyncAt) : 'In progress…'}
                    {apaleo.lastSyncStatus === 'failed' ? ' (failed)' : ''}
                  </dd>
                  {apaleo.lastSyncStats ? (
                    <>
                      <dt className="text-muted-foreground">Imported</dt>
                      <dd>
                        {apaleo.lastSyncStats.properties} properties, {apaleo.lastSyncStats.roomTypes} room
                        types, {apaleo.lastSyncStats.ratePlans} rate plans
                      </dd>
                    </>
                  ) : null}
                  <dt className="text-muted-foreground">Reservation updates</dt>
                  <dd>{apaleo.webhooksActive ? 'Real-time (webhooks)' : 'Polled periodically'}</dd>
                </dl>
                {apaleo.lastSyncError ? <Alert variant="error">{apaleo.lastSyncError}</Alert> : null}
                {canManage ? (
                  <div className="flex flex-wrap gap-2">
                    <form action={syncApaleo.bind(null, orgId)}>
                      <Button variant="outline" type="submit">
                        <RefreshCw /> Sync now
                      </Button>
                    </form>
                    {apaleo.status === 'error' ? (
                      <form action={connectApaleo.bind(null, orgId)}>
                        <Button type="submit">Reconnect</Button>
                      </form>
                    ) : null}
                    <form action={disconnectApaleo.bind(null, orgId)}>
                      <Button variant="ghost" type="submit" className="text-destructive">
                        Disconnect
                      </Button>
                    </form>
                  </div>
                ) : null}
              </>
            ) : canManage ? (
              <form action={connectApaleo.bind(null, orgId)}>
                <Button type="submit" size="lg">
                  <PlugZap /> Connect Apaleo
                </Button>
              </form>
            ) : (
              <p className="text-sm text-muted-foreground">Ask an admin to connect Apaleo.</p>
            )}
          </CardContent>
        </Card>

        <Card id="stripe">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Stripe payments</CardTitle>
              <Badge
                variant={
                  stripe.status === 'active'
                    ? 'success'
                    : stripe.status === 'not_connected'
                      ? 'secondary'
                      : 'warning'
                }
              >
                {
                  {
                    active: 'Connected',
                    onboarding: 'Setup incomplete',
                    restricted: 'Needs attention',
                    not_connected: 'Not connected',
                  }[stripe.status]
                }
              </Badge>
            </div>
            <CardDescription>
              Guests pay on your own Stripe account: you are the merchant of record, payouts go straight to
              you, and {BRAND.name}’s{' '}
              {(stripe.defaultFeeBps / 100).toFixed(stripe.defaultFeeBps % 100 ? 1 : 0)}% fee is deducted as
              an application fee on prepaid bookings (invoiced monthly for pay-at-hotel).
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 text-sm">
            {stripe.connected ? (
              <dl className="grid grid-cols-2 gap-2">
                <dt className="text-muted-foreground">Account</dt>
                <dd className="font-mono text-xs">{stripe.accountId}</dd>
                <dt className="text-muted-foreground">Payments</dt>
                <dd>{stripe.chargesEnabled ? 'Enabled' : 'Not yet enabled'}</dd>
                <dt className="text-muted-foreground">Payouts</dt>
                <dd>{stripe.payoutsEnabled ? 'Enabled' : 'Not yet enabled'}</dd>
              </dl>
            ) : null}
            {stripe.connected && stripe.requirementsDue.length > 0 ? (
              <Alert variant="warning">
                Stripe still needs some information before you can take bookings.
              </Alert>
            ) : null}
            {isOwner ? (
              <div className="flex flex-wrap gap-2">
                {stripe.status !== 'active' ? (
                  <form action={connectStripe.bind(null, orgId)}>
                    <Button type="submit" size={stripe.connected ? 'default' : 'lg'}>
                      <CreditCard /> {stripe.connected ? 'Continue Stripe setup' : 'Connect Stripe'}
                    </Button>
                  </form>
                ) : null}
                {stripe.connected ? (
                  <form action={refreshStripe.bind(null, orgId)}>
                    <Button variant="outline" type="submit">
                      <RefreshCw /> Refresh status
                    </Button>
                  </form>
                ) : null}
              </div>
            ) : (
              <p className="text-muted-foreground">Only owners can connect a payout account.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
