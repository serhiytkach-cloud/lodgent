import { CheckCircle2, Circle } from 'lucide-react';
import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader, Stat } from '@/components/ui/misc';
import { api } from '@/lib/api';
import type { Organization, Property } from '@/lib/types';

export default async function OverviewPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const [org, { properties }] = await Promise.all([
    api<Organization>(`/v1/orgs/${orgId}`),
    api<{ properties: Property[] }>(`/v1/orgs/${orgId}/properties`),
  ]);
  const published = properties.filter((p) => p.status === 'published').length;
  const steps = [
    {
      done: properties.some((p) => p.pmsPropertyId),
      label: 'Connect Apaleo and import your properties',
      href: `/app/${orgId}/settings/connections`,
    },
    { done: false, label: 'Connect Stripe to take payments', href: `/app/${orgId}/settings/connections` },
    {
      done: published > 0,
      label: 'Review your attribute profile and publish',
      href: `/app/${orgId}/properties`,
    },
  ];
  return (
    <>
      <PageHeader title={org.name} description="How AI agents find, quote and book your hotels." />
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Properties" value={properties.length} />
        <Stat label="Published to agents" value={published} />
        <Stat label="Your role" value={<span className="capitalize">{org.role}</span>} />
      </div>
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Get bookable by AI agents</CardTitle>
          <CardDescription>Three steps to start receiving direct bookings from agents.</CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="grid gap-3">
            {steps.map((step) => (
              <li key={step.label} className="flex items-center gap-3">
                {step.done ? (
                  <CheckCircle2 className="size-5 text-success" />
                ) : (
                  <Circle className="size-5 text-muted-foreground" />
                )}
                <Link href={step.href} className="text-sm hover:underline">
                  {step.label}
                </Link>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </>
  );
}
