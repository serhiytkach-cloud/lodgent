import { z } from 'zod';
import { PaymentModeSchema } from './offers';

export const AttributeSourceSchema = z.enum(['pms', 'website', 'hotel', 'ai_extracted']);
export const AttributeValueSchema = z.union([z.boolean(), z.number(), z.string()]);

export const EvidenceDto = z.object({ url: z.string(), snippet: z.string() });

export const SuggestionDto = z.object({
  assignmentId: z.uuid(),
  value: AttributeValueSchema,
  source: AttributeSourceSchema,
  confidence: z.number(),
  status: z.enum(['suggested', 'approved', 'rejected']),
  evidence: z.array(EvidenceDto),
});

export const AttributeRowDto = z.object({
  code: z.string(),
  label: z.string(),
  category: z.string(),
  valueType: z.enum(['boolean', 'enum', 'number', 'text']),
  enumValues: z.array(z.string()).nullable(),
  unit: z.string().nullable(),
  importance: z.number().int(),
  roomTypeId: z.uuid().nullable(),
  effective: z
    .object({ value: AttributeValueSchema, source: AttributeSourceSchema, assignmentId: z.uuid() })
    .nullable(),
  suggestions: z.array(SuggestionDto).describe('Suggestions awaiting review (and other sources’ values)'),
});
export type AttributeRowDto = z.infer<typeof AttributeRowDto>;

export const ProfileDto = z.object({
  propertyId: z.uuid(),
  completeness: z.object({
    score: z.number().int(),
    gaps: z.array(z.object({ key: z.string(), label: z.string(), message: z.string(), weight: z.number() })),
  }),
  pendingSuggestions: z.number().int(),
  categories: z.array(
    z.object({ code: z.string(), label: z.string(), attributes: z.array(AttributeRowDto) }),
  ),
  rooms: z.array(z.object({ roomTypeId: z.uuid(), name: z.string(), attributes: z.array(AttributeRowDto) })),
  descriptions: z.array(
    z.object({
      id: z.uuid(),
      roomTypeId: z.uuid().nullable(),
      roomTypeName: z.string().nullable(),
      text: z.string(),
      current: z.string().nullable(),
      source: AttributeSourceSchema,
      evidenceUrl: z.string().nullable(),
    }),
  ),
  crawl: z
    .object({
      id: z.uuid(),
      url: z.string(),
      status: z.enum(['queued', 'running', 'succeeded', 'failed']),
      pagesFetched: z.number().int(),
      model: z.string().nullable(),
      stats: z.record(z.string(), z.number()).nullable(),
      error: z.string().nullable(),
      createdAt: z.iso.datetime(),
      finishedAt: z.iso.datetime().nullable(),
    })
    .nullable(),
});
export type ProfileDto = z.infer<typeof ProfileDto>;

export const ReviewInput = z.object({
  approve: z.array(z.uuid()).max(500).default([]),
  reject: z.array(z.uuid()).max(500).default([]),
});

export const SetAttributeInput = z.object({
  attributeCode: z.string().max(60),
  roomTypeId: z.uuid().nullable().default(null),
  value: AttributeValueSchema.nullable().describe('null clears the value'),
});

export const PublishReadinessDto = z.object({
  status: z.enum(['draft', 'published', 'unpublished']),
  canPublish: z.boolean(),
  checks: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      ok: z.boolean(),
      required: z.boolean(),
      message: z.string(),
    }),
  ),
  completeness: z.number().int(),
  profileUrl: z.string(),
  jsonLd: z.record(z.string(), z.unknown()),
});

/** A published hotel as agents and the public profile page see it. */
export const HotelProfileDto = z.object({
  hotelId: z.uuid(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  address: z.object({
    line1: z.string().nullable(),
    city: z.string().nullable(),
    postalCode: z.string().nullable(),
    region: z.string().nullable(),
    countryCode: z.string().nullable(),
  }),
  location: z.object({ latitude: z.number(), longitude: z.number() }).nullable(),
  timeZone: z.string(),
  currency: z.string(),
  checkInTime: z.string().nullable(),
  checkOutTime: z.string().nullable(),
  website: z.string().nullable(),
  profileUrl: z.string(),
  photos: z.array(z.object({ url: z.string(), caption: z.string().optional() })),
  attributes: z.array(
    z.object({
      code: z.string(),
      label: z.string(),
      category: z.string(),
      value: AttributeValueSchema,
      display: z.string().describe('Human-readable value, e.g. "42 m²" or "paid"'),
    }),
  ),
  roomTypes: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      description: z.string().nullable(),
      maxOccupancy: z.number().int().nullable(),
      attributes: z.array(
        z.object({ code: z.string(), label: z.string(), value: AttributeValueSchema, display: z.string() }),
      ),
      ratePlans: z.array(
        z.object({
          id: z.uuid(),
          name: z.string(),
          description: z.string().nullable(),
          paymentMode: PaymentModeSchema,
          includes: z.array(z.string()),
          cancellationPolicy: z.string().nullable(),
        }),
      ),
    }),
  ),
  policies: z.array(z.object({ kind: z.string(), title: z.string(), description: z.string().nullable() })),
});
export type HotelProfileDto = z.infer<typeof HotelProfileDto>;
