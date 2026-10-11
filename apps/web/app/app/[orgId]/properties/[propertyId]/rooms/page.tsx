import { EmptyState, PageHeader } from '@/components/ui/misc';

export default function Page() {
  return (
    <>
      <PageHeader title="Rooms & rates" />
      <EmptyState title="Rooms and rate plans are imported from Apaleo." />
    </>
  );
}
