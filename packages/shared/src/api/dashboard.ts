import { z } from 'zod';
import { LocalTime, TimeZone } from '../dates';
import { CurrencyCode } from '../money';

export const RoleSchema = z.enum(['owner', 'admin', 'viewer']);
export type RoleDto = z.infer<typeof RoleSchema>;

export const Uuid = z.uuid();

export const MembershipSummary = z.object({
  organizationId: z.uuid(),
  organizationName: z.string(),
  organizationSlug: z.string(),
  role: RoleSchema,
});

export const MeResponse = z.object({
  user: z.object({ id: z.uuid(), email: z.string(), name: z.string().nullable() }),
  memberships: z.array(MembershipSummary),
});
export type MeResponse = z.infer<typeof MeResponse>;

export const OrganizationDto = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  billingEmail: z.string().nullable(),
  role: RoleSchema,
  createdAt: z.iso.datetime(),
});
export type OrganizationDto = z.infer<typeof OrganizationDto>;

export const CreateOrganizationInput = z.object({
  name: z.string().trim().min(2).max(120),
  billingEmail: z.email().optional(),
});

export const UpdateOrganizationInput = z
  .object({
    name: z.string().trim().min(2).max(120),
    billingEmail: z.email().nullable(),
  })
  .partial();

export const MemberDto = z.object({
  userId: z.uuid(),
  email: z.string(),
  name: z.string().nullable(),
  role: RoleSchema,
  createdAt: z.iso.datetime(),
});

export const InvitationDto = z.object({
  id: z.uuid(),
  email: z.string(),
  role: RoleSchema,
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});

export const CreateInvitationInput = z.object({
  email: z.email().transform((e) => e.toLowerCase()),
  role: RoleSchema,
});

export const AcceptInvitationInput = z.object({ token: z.string().min(20).max(200) });

export const PropertyStatusSchema = z.enum(['draft', 'published', 'unpublished']);

const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Expected a hex color such as #1d4ed8');
const HttpsUrl = z.url({ protocol: /^https?$/ }).max(2000);

export const PropertyInput = z.object({
  name: z.string().trim().min(2).max(160),
  description: z.string().trim().max(5000).nullable(),
  websiteUrl: HttpsUrl.nullable(),
  email: z.email().nullable(),
  phone: z.string().trim().max(40).nullable(),
  addressLine1: z.string().trim().max(200).nullable(),
  addressLine2: z.string().trim().max(200).nullable(),
  city: z.string().trim().max(120).nullable(),
  postalCode: z.string().trim().max(20).nullable(),
  region: z.string().trim().max(120).nullable(),
  countryCode: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .nullable(),
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
  timeZone: TimeZone,
  currency: CurrencyCode,
  checkInTime: LocalTime.nullable(),
  checkOutTime: LocalTime.nullable(),
  brandColor: HexColor.nullable(),
  logoUrl: HttpsUrl.nullable(),
  photos: z.array(z.object({ url: HttpsUrl, caption: z.string().max(200).optional() })).max(50),
});
export type PropertyInput = z.infer<typeof PropertyInput>;

export const CreatePropertyInput = PropertyInput.partial().required({ name: true });
export const UpdatePropertyInput = PropertyInput.partial();

export const PropertyDto = PropertyInput.extend({
  id: z.uuid(),
  organizationId: z.uuid(),
  slug: z.string(),
  status: PropertyStatusSchema,
  feeBps: z.number().int(),
  pmsPropertyId: z.string().nullable(),
  publishedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type PropertyDto = z.infer<typeof PropertyDto>;

export const AuditEntryDto = z.object({
  id: z.uuid(),
  actorType: z.enum(['user', 'system']),
  actorEmail: z.string().nullable(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  changes: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.iso.datetime(),
});

export const ErrorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
