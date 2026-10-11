import { ActionForm } from '@/components/action-form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input, Textarea } from '@/components/ui/form';
import { api } from '@/lib/api';
import type { Organization, Property } from '@/lib/types';
import { updateProperty } from '../../../actions';

type FieldSpec = {
  name: keyof Property;
  label: string;
  hint?: string;
  type?: string;
  placeholder?: string;
  span?: boolean;
};

const FIELDS: FieldSpec[] = [
  { name: 'name', label: 'Name', span: true },
  { name: 'websiteUrl', label: 'Website', type: 'url', placeholder: 'https://' },
  { name: 'email', label: 'Email', type: 'email' },
  { name: 'phone', label: 'Phone' },
  { name: 'addressLine1', label: 'Address' },
  { name: 'addressLine2', label: 'Address line 2' },
  { name: 'city', label: 'City' },
  { name: 'postalCode', label: 'Postal code' },
  { name: 'region', label: 'Region' },
  { name: 'countryCode', label: 'Country code', hint: 'ISO 3166, e.g. PT' },
  { name: 'latitude', label: 'Latitude', type: 'number' },
  { name: 'longitude', label: 'Longitude', type: 'number' },
  { name: 'timeZone', label: 'Time zone', hint: 'IANA zone, e.g. Europe/Lisbon' },
  { name: 'currency', label: 'Currency', hint: 'ISO 4217, e.g. EUR' },
  { name: 'checkInTime', label: 'Check-in from', placeholder: '15:00' },
  { name: 'checkOutTime', label: 'Check-out until', placeholder: '11:00' },
  { name: 'brandColor', label: 'Brand color', hint: 'Used on the checkout page, e.g. #1d4ed8' },
  { name: 'logoUrl', label: 'Logo URL', type: 'url' },
];

export default async function PropertyDetailsPage({
  params,
}: {
  params: Promise<{ orgId: string; propertyId: string }>;
}) {
  const { orgId, propertyId } = await params;
  const [org, p] = await Promise.all([
    api<Organization>(`/v1/orgs/${orgId}`),
    api<Property>(`/v1/orgs/${orgId}/properties/${propertyId}`),
  ]);
  const readOnly = org.role === 'viewer';
  const fields = (
    <div className="grid gap-4 sm:grid-cols-2">
      {FIELDS.map((f) => (
        <Field
          key={f.name}
          label={f.label}
          htmlFor={f.name}
          name={f.name}
          hint={f.hint}
          className={f.span ? 'sm:col-span-2' : undefined}
        >
          <Input
            id={f.name}
            name={f.name}
            type={f.type ?? 'text'}
            step={f.type === 'number' ? 'any' : undefined}
            placeholder={f.placeholder}
            defaultValue={(p[f.name] as string | number | null) ?? ''}
            disabled={readOnly}
          />
        </Field>
      ))}
      <Field label="Description" htmlFor="description" name="description" className="sm:col-span-2">
        <Textarea
          id="description"
          name="description"
          rows={5}
          defaultValue={p.description ?? ''}
          disabled={readOnly}
        />
      </Field>
    </div>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Property details</CardTitle>
        <CardDescription>
          Basic facts shown to agents and guests. Apaleo sync fills empty fields but never overwrites your
          edits.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {readOnly ? (
          fields
        ) : (
          <ActionForm action={updateProperty.bind(null, orgId, propertyId)}>{fields}</ActionForm>
        )}
      </CardContent>
    </Card>
  );
}
