import type { ProfileDto } from '@lodgent/shared';
import { api } from '@/lib/api';
import type { Organization, Property } from '@/lib/types';
import { ProfileEditor } from './profile-editor';

export default async function PropertyProfilePage({
  params,
}: {
  params: Promise<{ orgId: string; propertyId: string }>;
}) {
  const { orgId, propertyId } = await params;
  const [org, property, profile] = await Promise.all([
    api<Organization>(`/v1/orgs/${orgId}`),
    api<Property>(`/v1/orgs/${orgId}/properties/${propertyId}`),
    api<ProfileDto>(`/v1/orgs/${orgId}/properties/${propertyId}/profile`),
  ]);
  return (
    <ProfileEditor
      orgId={orgId}
      propertyId={propertyId}
      profile={profile}
      canEdit={org.role !== 'viewer'}
      websiteUrl={property.websiteUrl}
    />
  );
}
