import { EmptyState, PageHeader } from '@/components/ui/misc';

export default function Page() {
  return (
    <>
      <PageHeader title="Agent funnel" />
      <EmptyState title="The agent funnel is coming soon." />
    </>
  );
}
