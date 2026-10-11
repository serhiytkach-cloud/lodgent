import type {
  GuaranteeType,
  PmsOffer,
  PmsOfferLine,
  PmsProperty,
  PmsRatePlan,
  PmsReservation,
  PmsRoomType,
} from '@lodgent/core';
import { addMoney, fromMajor, type Money, sumMoney } from '@lodgent/shared';
import type { z } from 'zod';
import type { ApaleoOffer, PropertyItem, RatePlanItem, ReservationStatus, UnitGroupItem } from './schemas';

export function toGuarantee(value: 'PM6Hold' | 'CreditCard' | 'Prepayment' | 'Company'): GuaranteeType {
  switch (value) {
    case 'PM6Hold':
      return 'none';
    case 'CreditCard':
      return 'credit_card';
    case 'Prepayment':
      return 'prepayment';
    case 'Company':
      return 'company';
  }
}

export function fromGuarantee(value: GuaranteeType): 'PM6Hold' | 'CreditCard' | 'Prepayment' | 'Company' {
  return (
    { none: 'PM6Hold', credit_card: 'CreditCard', prepayment: 'Prepayment', company: 'Company' } as const
  )[value];
}

const money = (value: { amount: number; currency: string }): Money => fromMajor(value.amount, value.currency);

export function toProperty(p: z.infer<typeof PropertyItem>): PmsProperty {
  return {
    pmsId: p.id,
    code: p.code,
    name: p.name,
    description: p.description ?? null,
    address: {
      line1: p.location?.addressLine1 ?? null,
      line2: p.location?.addressLine2 ?? null,
      postalCode: p.location?.postalCode ?? null,
      city: p.location?.city ?? null,
      region: p.location?.regionCode ?? null,
      countryCode: p.location?.countryCode ?? null,
    },
    timeZone: p.timeZone,
    currency: p.currencyCode,
    isLive: p.status === 'Live',
  };
}

export function toRoomType(u: z.infer<typeof UnitGroupItem>): PmsRoomType {
  return {
    pmsId: u.id,
    pmsPropertyId: u.property.id,
    code: u.code,
    name: u.name,
    description: u.description ?? null,
    maxOccupancy: u.maxPersons ?? null,
    unitCount: u.memberCount,
  };
}

export function toRatePlan(r: z.infer<typeof RatePlanItem>): PmsRatePlan {
  return {
    pmsId: r.id,
    pmsPropertyId: r.property.id,
    pmsRoomTypeId: r.unitGroup.id,
    code: r.code,
    name: r.name,
    description: r.description ?? null,
    minGuarantee: toGuarantee(r.minGuaranteeType),
    channelCodes: r.channelCodes,
    isBookable: r.isBookable && !r.isArchived,
    cancellationPolicy: r.cancellationPolicy
      ? {
          pmsId: r.cancellationPolicy.id,
          code: r.cancellationPolicy.code ?? null,
          name: r.cancellationPolicy.name ?? null,
          description: r.cancellationPolicy.description ?? null,
        }
      : null,
    includedServices: (r.includedServices ?? []).map((s) => ({
      code: s.service.code ?? null,
      name: s.service.name ?? s.service.code ?? 'Included service',
      description: s.service.description ?? null,
    })),
  };
}

/**
 * Converts an Apaleo offer into an all-in price. Apaleo's `totalGrossAmount` contains the rate with
 * VAT and included services; city taxes, `fees` ("added on top of the TotalGrossAmount") and
 * mandatory `services` are added so the guest sees the full price up front (US FTC junk-fee rule,
 * EU price-indication rules). Returns null for offers Apaleo marks as not bookable.
 */
export function toOffer(o: ApaleoOffer): PmsOffer | null {
  if ((o.validationMessages ?? []).length > 0 || o.availableUnits <= 0) return null;
  const currency = o.totalGrossAmount.currency;
  const accommodation = money(o.totalGrossAmount);
  const extras: PmsOfferLine[] = [
    ...(o.cityTaxes ?? []).map((c) => ({ label: c.name, amount: money(c.totalGrossAmount) })),
    ...(o.fees ?? []).map((f) => ({
      label: f.name,
      amount: fromMajor(f.totalAmount.grossAmount, f.totalAmount.currency),
    })),
    ...(o.services ?? []).map((s) => ({
      label: s.service.name ?? s.service.code ?? 'Mandatory service',
      amount: fromMajor(s.totalAmount.grossAmount, s.totalAmount.currency),
    })),
  ].filter((line) => line.amount.amount !== 0);
  const total = extras.reduce((acc, line) => addMoney(acc, line.amount), accommodation);
  const includedTaxes = sumMoney(
    o.taxDetails.filter((t) => t.tax.currency === currency).map((t) => money(t.tax)),
    currency,
  );
  const dueDate = o.cancellationFee.dueDateTime ? new Date(o.cancellationFee.dueDateTime) : null;
  return {
    pmsRoomTypeId: o.unitGroup.id,
    roomTypeName: o.unitGroup.name,
    pmsRatePlanId: o.ratePlan.id,
    ratePlanName: o.ratePlan.name ?? o.ratePlan.code ?? 'Rate',
    ratePlanDescription: o.ratePlan.description ?? null,
    minGuarantee: toGuarantee(o.minGuaranteeType),
    availableUnits: o.availableUnits,
    total,
    accommodation,
    includedTaxes,
    extras,
    prepayment: o.prePaymentAmount ? money(o.prePaymentAmount) : { amount: 0, currency },
    nightly: o.timeSlices.map((t) => ({ date: t.from.slice(0, 10), amount: money(t.totalGrossAmount) })),
    cancellation: {
      code: o.cancellationFee.code ?? null,
      name: o.cancellationFee.name ?? null,
      description: o.cancellationFee.description ?? null,
      freeUntil: dueDate && !Number.isNaN(dueDate.getTime()) ? dueDate : null,
      fee: money(o.cancellationFee.fee),
    },
    noShowFee: o.noShowFee ? money(o.noShowFee.fee) : null,
  };
}

export function toReservationStatus(status: z.infer<typeof ReservationStatus>): PmsReservation['status'] {
  return (
    {
      Confirmed: 'confirmed',
      InHouse: 'in_house',
      CheckedOut: 'checked_out',
      Canceled: 'cancelled',
      NoShow: 'no_show',
    } as const
  )[status];
}
