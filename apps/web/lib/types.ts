import type {
  AuditEntryDto,
  InvitationDto,
  MemberDto,
  MeResponse,
  OrganizationDto,
  PropertyDto,
} from '@lodgent/shared';
import type { z } from 'zod';

export type Me = MeResponse;
export type Organization = OrganizationDto;
export type Property = PropertyDto;
export type Member = z.infer<typeof MemberDto>;
export type Invitation = z.infer<typeof InvitationDto>;
export type AuditEntry = z.infer<typeof AuditEntryDto>;
