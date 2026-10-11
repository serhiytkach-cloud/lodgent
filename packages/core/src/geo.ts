/** Great-circle distance in kilometres. */
export function haversineKm(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function foldText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Optimal string alignment distance (Damerau–Levenshtein with adjacent transpositions). */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  }
  return d[a.length]![b.length]!;
}

/** Tolerates small spelling differences between names ("Lisbon" / "Lisboa"), scaled to word length. */
function similarWord(a: string, b: string): boolean {
  if (a === b) return true;
  const len = Math.min(a.length, b.length);
  if (len < 4) return false;
  return editDistance(a, b) <= (len >= 6 ? 2 : 1);
}

export interface PlaceNames {
  city: string | null;
  region: string | null;
  countryCode: string | null;
  /** English country name, e.g. from Intl.DisplayNames. */
  countryName: string | null;
  hotelName: string;
}

/**
 * Whether a free-text destination ("Lisbon", "Seefeld, Austria", "Charleston SC") refers to this
 * place. Every word group of the destination must match the city, region, country or hotel name.
 */
export function destinationMatches(destination: string, place: PlaceNames): boolean {
  const parts = destination
    .split(/[,;/]| - /)
    .map(foldText)
    .filter((p) => p.length > 0);
  if (parts.length === 0) return true;
  const fields = [place.city, place.region, place.countryName, place.hotelName]
    .filter((f): f is string => !!f)
    .map(foldText);
  const code = place.countryCode?.toLowerCase() ?? null;
  return parts.every((part) => {
    if (code && part === code) return true;
    if (part === 'usa' && code === 'us') return true;
    if ((part === 'uk' || part === 'great britain') && code === 'gb') return true;
    const words = part.split(' ');
    return fields.some((field) => {
      if (field === part || field.includes(part)) return true;
      const fieldWords = field.split(' ');
      // Every word of the part must resemble some word in the field ("charleston sc" vs region "sc").
      return words.every(
        (w) =>
          fieldWords.some((fw) => similarWord(w, fw)) ||
          (code !== null && w === code) ||
          place.region?.toLowerCase() === w,
      );
    });
  });
}
