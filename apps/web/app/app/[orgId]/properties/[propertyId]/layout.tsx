import Link from 'next/link';
import type { ReactNode } from 'react';
import { PropertyStatusBadge } from '@/components/status';
import { api } from '@/lib/api';
import type { Property } from '@/lib/types';
import { PropertyTabs } from './tabs';

export default async function PropertyLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ orgId: string; propertyId: string }>;
}) {
  const { orgId, propertyId } = await params;
  const property = await api<Property>(`/v1/orgs/${orgId}/properties/${propertyId}`);
  return (
    <>
      <div className="mb-2 text-sm text-muted-foreground">
        <Link href={`/app/${orgId}/properties`} className="hover:underline">
          Properties
        </Link>{' '}
        / {property.name}
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{property.name}</h1>
        <PropertyStatusBadge status={property.status} />
      </div>
      <PropertyTabs base={`/app/${orgId}/properties/${propertyId}`} />
      <div className="mt-6">{children}</div>
    </>
  );
}
