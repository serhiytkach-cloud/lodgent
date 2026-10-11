import { applyBasisPoints, type Money } from '@lodgent/shared';

/** Default booking fee: 2% of the all-in stay total. Overridable per property. */
export const DEFAULT_FEE_BPS = 200;

/** Upper bound for a configurable fee so a typo can't charge a hotel 200%. */
export const MAX_FEE_BPS = 2_000;

/** The fee the platform earns on a booking, computed on the all-in total the guest pays. */
export function bookingFee(total: Money, feeBps: number): Money {
  if (feeBps > MAX_FEE_BPS) throw new Error(`Fee of ${feeBps} bps exceeds the ${MAX_FEE_BPS} bps maximum`);
  return applyBasisPoints(total, feeBps);
}
