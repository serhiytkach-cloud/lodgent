import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/form';
import { PageHeader } from '@/components/ui/misc';
import { api } from '@/lib/api';
import type { Organization } from '@/lib/types';
import { updateOrganization } from '../actions';

export default async function SettingsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const org = await api<Organization>(`/v1/orgs/${orgId}`);
  const readOnly = org.role === 'viewer';
  return (
    <>
      <PageHeader
        title="Settings"
        actions={
          <Link href={`/app/${orgId}/settings/connections`} className="text-sm text-primary hover:underline">
            Connections →
          </Link>
        }
      />
      <Card>
        <CardHeader>
          <CardTitle>Organization</CardTitle>
          <CardDescription>Your organization’s name and where fee invoices are sent.</CardDescription>
        </CardHeader>
        <CardContent>
          {readOnly ? (
            <dl className="grid gap-2 text-sm">
              <div>
                <dt className="text-muted-foreground">Name</dt>
                <dd>{org.name}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Billing email</dt>
                <dd>{org.billingEmail ?? '—'}</dd>
              </div>
            </dl>
          ) : (
            <ActionForm action={updateOrganization.bind(null, orgId)} className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" htmlFor="name" name="name">
                <Input id="name" name="name" defaultValue={org.name} required />
              </Field>
              <Field label="Billing email" htmlFor="billingEmail" name="billingEmail">
                <Input
                  id="billingEmail"
                  name="billingEmail"
                  type="email"
                  defaultValue={org.billingEmail ?? ''}
                />
              </Field>
            </ActionForm>
          )}
        </CardContent>
      </Card>
    </>
  );
}
