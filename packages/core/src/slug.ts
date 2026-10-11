/** URL-safe slug: lower case ASCII, words joined by hyphens, at most `maxLength` characters. */
export function slugify(value: string, maxLength = 60): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return slug || 'hotel';
}

/**
 * Picks the first free slug: `base`, then `base-2`, `base-3`… `exists` is the uniqueness check.
 * The database unique constraint stays the final arbiter.
 */
export async function uniqueSlug(
  base: string,
  exists: (candidate: string) => Promise<boolean>,
): Promise<string> {
  const root = slugify(base);
  if (!(await exists(root))) return root;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${root.slice(0, 55)}-${n}`;
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error(`Could not find a free slug for "${base}"`);
}
