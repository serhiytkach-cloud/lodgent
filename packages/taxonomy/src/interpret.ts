import { ATTRIBUTES, type AttributeDefinition, type AttributeValue } from './index';

/**
 * A traveller requirement mapped onto the vocabulary. `codes` are alternatives: "dog friendly" is
 * satisfied by `pets_allowed` or `dogs_allowed`. `value` narrows enum attributes ("free parking").
 */
export interface InterpretedRequirement {
  input: string;
  codes: string[];
  label: string;
  value?: AttributeValue;
}

export function normalizePhrase(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^\p{L}\p{N}'&/+-]+/gu, ' ')
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-word containment; a plural "s"/"es" on the haystack side still matches ("ski lifts"). */
function containsWord(haystack: string, needle: string): boolean {
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(needle)}(?:e?s)?(?=$|[^\\p{L}\\p{N}])`, 'u').test(
    haystack,
  );
}

interface Term {
  term: string;
  def: AttributeDefinition;
}

let terms: Term[] | null = null;

/** Built lazily: this module and the vocabulary import each other. */
function allTerms(): Term[] {
  terms ??= ATTRIBUTES.flatMap((def) =>
    [def.code.replace(/_/g, ' '), def.label, ...def.synonyms].map((t) => ({ term: normalizePhrase(t), def })),
  )
    .filter((t) => t.term.length >= 3)
    // Longest terms first, so "ski lift" beats "lift" and "rooftop bar" beats "bar".
    .sort((a, b) => b.term.length - a.term.length || b.def.importance - a.def.importance);
  return terms;
}

/**
 * Maps a free-text requirement ("dog friendly", "free parking", "pets_allowed") to attribute codes.
 * Returns null when nothing in the vocabulary matches; callers treat that as a soft preference.
 */
export function interpretRequirement(input: string): InterpretedRequirement | null {
  const phrase = normalizePhrase(input);
  if (phrase.length === 0) return null;
  const exact = ATTRIBUTES.find((a) => a.code === input.trim().toLowerCase());
  if (exact) return { input, codes: [exact.code], label: exact.label };

  const TERMS = allTerms();
  const best = TERMS.find((t) => containsWord(phrase, t.term));
  if (!best) return null;
  // Every attribute that lists the same matched term is an acceptable alternative.
  const codes = [...new Set(TERMS.filter((t) => t.term === best.term).map((t) => t.def.code))];
  const primary = best.def;
  const enumValue =
    primary.valueType === 'enum'
      ? primary.enumValues?.find((v) => v !== 'none' && containsWord(phrase, v.replace(/_/g, ' ')))
      : undefined;
  return {
    input,
    codes,
    label: enumValue ? `${primary.label}: ${enumValue.replace(/_/g, ' ')}` : primary.label,
    ...(enumValue ? { value: enumValue } : {}),
  };
}
