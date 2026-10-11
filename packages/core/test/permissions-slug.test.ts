import { describe, expect, it } from 'vitest';
import { can, canGrantRole, PERMISSIONS, ROLES, slugify, uniqueSlug } from '../src';

describe('permissions', () => {
  it('lets owners do everything', () => {
    for (const permission of Object.keys(PERMISSIONS) as (keyof typeof PERMISSIONS)[]) {
      expect(can('owner', permission)).toBe(true);
    }
  });

  it('keeps viewers read-only', () => {
    const writes = Object.keys(PERMISSIONS).filter((p) => !p.endsWith('.read'));
    for (const permission of writes as (keyof typeof PERMISSIONS)[]) {
      expect(can('viewer', permission)).toBe(false);
    }
  });

  it('reserves money and people management for owners', () => {
    expect(can('admin', 'payments.manage')).toBe(false);
    expect(can('admin', 'members.manage')).toBe(false);
    expect(can('admin', 'property.publish')).toBe(true);
  });

  it('never lets anyone grant above their own role', () => {
    expect(canGrantRole('admin', 'owner')).toBe(false);
    expect(canGrantRole('admin', 'admin')).toBe(true);
    expect(canGrantRole('owner', 'owner')).toBe(true);
    for (const role of ROLES) expect(canGrantRole('viewer', role)).toBe(false);
  });
});

describe('slugs', () => {
  it('normalizes names', () => {
    expect(slugify('Hôtel des Arts & Métiers, Paris')).toBe('hotel-des-arts-and-metiers-paris');
    expect(slugify('  ***  ')).toBe('hotel');
  });

  it('finds a free slug', async () => {
    const taken = new Set(['casa-azul', 'casa-azul-2']);
    expect(await uniqueSlug('Casa Azul', async (s) => taken.has(s))).toBe('casa-azul-3');
  });
});
