import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { Alert, PageHeader } from '@/components/ui/misc';
import { api } from '@/lib/api';
import type { Organization } from '@/lib/types';
import { EraseGuestData, ExportGuestData } from './guest-data-tools';

export default async function GuestDataPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const org = await api<Organization>(`/v1/orgs/${orgId}`);
  const canManage = org.role === 'owner' || org.role === 'admin';
  return (
    <>
      <Link
        href={`/app/${orgId}/settings`}
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Settings
      </Link>
      <PageHeader
        title="Guest data"
        description="Answer guests’ privacy requests: export what we hold about a guest, or erase it. Guest details are also erased automatically some time after each stay."
      />
      {canManage ? (
        <div className="grid gap-6">
          <ExportGuestData orgId={orgId} />
          <EraseGuestData orgId={orgId} />
        </div>
      ) : (
        <Alert variant="info">Only owners and admins can export or erase guest data.</Alert>
      )}
    </>
  );
}
