import { addDays, localDateAt } from '@lodgent/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/form';
import { Alert, Badge, EmptyState, Table, Td, Th } from '@/components/ui/misc';
import { ApiError, api } from '@/lib/api';
import type { Organization, Property } from '@/lib/types';
import { setRatePlanExposure } from './actions';

interface RatePlan {
  id: string;
  name: string;
  code: string | null;
  description: string | null;
  minGuarantee: string;
  paymentMode: 'prepaid' | 'pay_at_hotel' | null;
  isBookable: boolean;
  exposedToAgents: boolean;
  includes: string[];
  cancellationPolicy: { title: string; description: string | null } | null;
}

interface RoomsResponse {
  roomTypes: {
    id: string;
    name: string;
    description: string | null;
    maxOccupancy: number | null;
    unitCount: number | null;
    ratePlans: RatePlan[];
  }[];
}

interface PreviewOffer {
  roomTypeName: string;
  ratePlanName: string;
  exposedToAgents: boolean;
  paymentMode: string | null;
  total: { formatted: string };
  availableUnits: number;
  cancellation: string;
}

function PaymentBadge({ mode }: { mode: RatePlan['paymentMode'] }) {
  if (mode === 'prepaid') return <Badge variant="default">Prepaid</Badge>;
  if (mode === 'pay_at_hotel') return <Badge variant="secondary">Pay at hotel</Badge>;
  return <Badge variant="outline">Company only</Badge>;
}

export default async function RoomsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; propertyId: string }>;
  searchParams: Promise<{ checkIn?: string; checkOut?: string; adults?: string }>;
}) {
  const { orgId, propertyId } = await params;
  const query = await searchParams;
  const [org, property, rooms] = await Promise.all([
    api<Organization>(`/v1/orgs/${orgId}`),
    api<Property>(`/v1/orgs/${orgId}/properties/${propertyId}`),
    api<RoomsResponse>(`/v1/orgs/${orgId}/properties/${propertyId}/rooms`),
  ]);
  const canPublish = org.role !== 'viewer';
  const today = localDateAt(new Date(), property.timeZone);
  const checkIn = query.checkIn ?? addDays(today, 14);
  const checkOut = query.checkOut ?? addDays(checkIn, 2);
  const adults = query.adults ?? '2';

  let preview: PreviewOffer[] | null = null;
  let previewError: string | null = null;
  if (query.checkIn) {
    try {
      preview = (
        await api<{ offers: PreviewOffer[] }>(
          `/v1/orgs/${orgId}/properties/${propertyId}/offer-preview?${new URLSearchParams({ checkIn, checkOut, adults })}`,
        )
      ).offers;
    } catch (error) {
      if (error instanceof ApiError) previewError = error.message;
      else throw error;
    }
  }

  if (rooms.roomTypes.length === 0) {
    return (
      <EmptyState title="No room types yet">Room types and rate plans are imported from Apaleo.</EmptyState>
    );
  }

  return (
    <div className="grid gap-6">
      <Alert variant="info">
        Choose which rate plans AI agents may sell. Prepaid rates are charged in full at checkout;
        pay-at-hotel rates are guaranteed with a card. Company rates are never offered to agents.
      </Alert>
      {rooms.roomTypes.map((rt) => (
        <Card key={rt.id}>
          <CardHeader>
            <CardTitle>{rt.name}</CardTitle>
            <CardDescription>
              {rt.description} {rt.maxOccupancy ? `· Up to ${rt.maxOccupancy} guests` : ''}{' '}
              {rt.unitCount ? `· ${rt.unitCount} rooms` : ''}
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <thead>
                <tr>
                  <Th>Rate plan</Th>
                  <Th>Payment</Th>
                  <Th>Cancellation</Th>
                  <Th className="text-right">Agents</Th>
                </tr>
              </thead>
              <tbody>
                {rt.ratePlans.map((rp) => (
                  <tr key={rp.id}>
                    <Td>
                      <div className="font-medium">{rp.name}</div>
                      {rp.includes.length > 0 ? (
                        <div className="text-xs text-muted-foreground">Includes {rp.includes.join(', ')}</div>
                      ) : null}
                    </Td>
                    <Td>
                      <PaymentBadge mode={rp.paymentMode} />
                    </Td>
                    <Td className="max-w-xs text-xs text-muted-foreground">
                      {rp.cancellationPolicy?.title ?? '—'}
                    </Td>
                    <Td className="text-right">
                      {rp.paymentMode === null || !rp.isBookable ? (
                        <span className="text-xs text-muted-foreground">Not sellable</span>
                      ) : canPublish ? (
                        <form
                          action={setRatePlanExposure.bind(
                            null,
                            orgId,
                            propertyId,
                            rp.id,
                            !rp.exposedToAgents,
                          )}
                        >
                          <Button
                            size="sm"
                            variant={rp.exposedToAgents ? 'secondary' : 'outline'}
                            type="submit"
                            aria-label={`${rp.exposedToAgents ? 'Stop selling' : 'Sell'} ${rt.name} ${rp.name} via agents`}
                          >
                            {rp.exposedToAgents ? 'Selling ✓' : 'Sell via agents'}
                          </Button>
                        </form>
                      ) : rp.exposedToAgents ? (
                        <Badge variant="success">Selling</Badge>
                      ) : (
                        <Badge variant="secondary">Off</Badge>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </CardContent>
        </Card>
      ))}

      <Card>
        <CardHeader>
          <CardTitle>Live offer preview</CardTitle>
          <CardDescription>
            What Apaleo returns for a stay right now, including rates you don’t sell via agents.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <form className="flex flex-wrap items-end gap-3" method="get">
            <div className="grid gap-1.5">
              <Label htmlFor="checkIn">Check-in</Label>
              <Input id="checkIn" name="checkIn" type="date" defaultValue={checkIn} min={today} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="checkOut">Check-out</Label>
              <Input id="checkOut" name="checkOut" type="date" defaultValue={checkOut} />
            </div>
            <div className="grid w-24 gap-1.5">
              <Label htmlFor="adults">Adults</Label>
              <Input id="adults" name="adults" type="number" min={1} max={10} defaultValue={adults} />
            </div>
            <Button type="submit" variant="outline">
              Check
            </Button>
          </form>
          {previewError ? <Alert variant="error">{previewError}</Alert> : null}
          {preview ? (
            preview.length === 0 ? (
              <p className="text-sm text-muted-foreground">No availability for these dates.</p>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Room</Th>
                    <Th>Rate</Th>
                    <Th>All-in total</Th>
                    <Th>Left</Th>
                    <Th>Agents</Th>
                  </tr>
                </thead>
                <tbody>
                  {preview.map((o) => (
                    <tr key={`${o.roomTypeName}-${o.ratePlanName}`}>
                      <Td>{o.roomTypeName}</Td>
                      <Td>
                        <div>{o.ratePlanName}</div>
                        <div className="text-xs text-muted-foreground">{o.cancellation}</div>
                      </Td>
                      <Td className="font-medium tabular-nums">{o.total.formatted}</Td>
                      <Td>{o.availableUnits}</Td>
                      <Td>
                        {o.exposedToAgents ? (
                          <Badge variant="success">Yes</Badge>
                        ) : (
                          <Badge variant="secondary">No</Badge>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
