import { EmptyState, PageHeader } from '@/components/ui/misc';

export default function Page() {
  return (
    <>
      <PageHeader title="Bookings & fees" />
      <EmptyState title="Bookings will appear here." />
    </>
  );
}
