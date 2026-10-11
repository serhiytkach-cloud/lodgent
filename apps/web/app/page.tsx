import { BRAND } from '@lodgent/shared';

export default function HomePage() {
  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-3xl font-semibold">{BRAND.name}</h1>
      <p className="mt-2 text-neutral-600">{BRAND.tagline}</p>
    </main>
  );
}
