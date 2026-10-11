import { type AppliesTo, CATEGORIES, type CategoryCode, ROWS, type ValueType } from './attributes';

export { CATEGORIES, type CategoryCode } from './attributes';

export interface AttributeDefinition {
  code: string;
  label: string;
  category: CategoryCode;
  appliesTo: AppliesTo;
  /** 1–5: how often agents and travellers filter on this. Drives completeness scoring and gap ranking. */
  importance: number;
  valueType: ValueType;
  enumValues: string[] | null;
  unit: string | null;
  synonyms: string[];
  /** How the attribute appears in schema.org markup. */
  schemaOrg:
    | { property: 'amenityFeature' }
    | { property: 'petsAllowed' }
    | { property: 'smokingAllowed'; invert: true };
}

function build(): AttributeDefinition[] {
  const all: AttributeDefinition[] = [];
  for (const category of CATEGORIES) {
    for (const [code, label, appliesTo, importance, synonyms, valueType] of ROWS[category.code]) {
      all.push({
        code,
        label,
        category: category.code,
        appliesTo,
        importance,
        valueType: valueType?.type ?? 'boolean',
        enumValues: valueType?.type === 'enum' ? valueType.values : null,
        unit: valueType?.type === 'number' ? valueType.unit : null,
        synonyms,
        schemaOrg:
          code === 'pets_allowed'
            ? { property: 'petsAllowed' }
            : code === 'non_smoking'
              ? { property: 'smokingAllowed', invert: true }
              : { property: 'amenityFeature' },
      });
    }
  }
  return all;
}

export const ATTRIBUTES: readonly AttributeDefinition[] = build();

const BY_CODE = new Map(ATTRIBUTES.map((a) => [a.code, a]));

export function attribute(code: string): AttributeDefinition | undefined {
  return BY_CODE.get(code);
}

export function isKnownAttribute(code: string): boolean {
  return BY_CODE.has(code);
}

export function categoryLabel(code: string): string {
  return CATEGORIES.find((c) => c.code === code)?.label ?? code;
}

export type AttributeValue = boolean | number | string;

/** Validates and normalizes a value for an attribute; returns null if it doesn't fit the type. */
export function normalizeValue(def: AttributeDefinition, value: unknown): AttributeValue | null {
  switch (def.valueType) {
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 'yes') return true;
      if (value === 'false' || value === 'no') return false;
      return null;
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n) && n >= 0 && n < 1_000_000 ? Math.round(n * 100) / 100 : null;
    }
    case 'enum':
      return typeof value === 'string' && def.enumValues?.includes(value) ? value : null;
    case 'text':
      return typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, 300) : null;
  }
}

/** Whether a value counts as "the hotel has this" for filtering (true, a number, a non-'none' enum, text). */
export function isTruthyValue(value: unknown): boolean {
  if (value === false || value === null || value === undefined) return false;
  if (value === 'none') return false;
  return true;
}

/** Human-readable value for display and JSON-LD. */
export function displayValue(def: AttributeDefinition, value: unknown): string {
  if (def.valueType === 'boolean') return value ? 'Yes' : 'No';
  if (def.valueType === 'number') return `${value}${def.unit ? ` ${def.unit}` : ''}`;
  if (def.valueType === 'enum') return String(value).replace(/_/g, ' ');
  return String(value);
}

export { type InterpretedRequirement, interpretRequirement, normalizePhrase } from './interpret';
