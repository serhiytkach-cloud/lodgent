import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { PropertyStatusBadge } from '@/components/status';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/form';
import { EmptyState, PageHeader, Table, Td, Th } from '@/components/ui/misc';
import { api } from '@/lib/api';
import type { Organization, Property } from '@/lib/types';
import { createProperty } from '../actions';

export default async function PropertiesPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const [org, { properties }] = await Promise.all([
    api<Organization>(`/v1/orgs/${orgId}`),
    api<{ properties: Property[] }>(`/v1/orgs/${orgId}/properties`),
  ]);
  const canWrite = org.role !== 'viewer';
  return (
    <>
      <PageHeader
        title="Properties"
        description="Hotels in this organization. Properties are imported from Apaleo; you can also add one by hand."
      />
      {properties.length === 0 ? (
        <EmptyState title="No properties yet">
          Connect Apaleo under{' '}
          <Link className="text-primary hover:underline" href={`/app/${orgId}/settings/connections`}>
            Settings → Connections
          </Link>{' '}
          to import them.
        </EmptyState>
      ) : (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Location</Th>
                <Th>Status</Th>
                <Th>PMS</Th>
              </tr>
            </thead>
            <tbody>
              {properties.map((p) => (
                <tr key={p.id} className="hover:bg-muted/50">
                  <Td>
                    <Link href={`/app/${orgId}/properties/${p.id}`} className="font-medium hover:underline">
                      {p.name}
                    </Link>
                  </Td>
                  <Td className="text-muted-foreground">
                    {[p.city, p.countryCode].filter(Boolean).join(', ') || '—'}
                  </Td>
                  <Td>
                    <PropertyStatusBadge status={p.status} />
                  </Td>
                  <Td className="text-muted-foreground">
                    {p.pmsPropertyId ? `Apaleo ${p.pmsPropertyId}` : 'Manual'}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
      {canWrite ? (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Add a property manually</CardTitle>
            <CardDescription>Only needed for hotels that aren’t in your Apaleo account.</CardDescription>
          </CardHeader>
          <CardContent>
            <ActionForm
              action={createProperty.bind(null, orgId)}
              submitLabel="Add property"
              className="grid gap-4 sm:grid-cols-2"
            >
              <Field label="Name" htmlFor="name" name="name">
                <Input id="name" name="name" required />
              </Field>
              <Field label="City" htmlFor="city">
                <Input id="city" name="city" />
              </Field>
              <Field
                label="Country code"
                htmlFor="countryCode"
                hint="Two letters, e.g. PT"
                name="countryCode"
              >
                <Input id="countryCode" name="countryCode" maxLength={2} />
              </Field>
              <Field label="Website" htmlFor="websiteUrl" name="websiteUrl">
                <Input id="websiteUrl" name="websiteUrl" type="url" placeholder="https://" />
              </Field>
              <Field label="Time zone" htmlFor="timeZone" name="timeZone">
                <Input id="timeZone" name="timeZone" defaultValue="Europe/Lisbon" />
              </Field>
              <Field label="Currency" htmlFor="currency" name="currency">
                <Input id="currency" name="currency" defaultValue="EUR" maxLength={3} />
              </Field>
            </ActionForm>
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}
