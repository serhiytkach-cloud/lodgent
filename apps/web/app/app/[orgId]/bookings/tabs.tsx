import Link from 'next/link';
import { cn } from '@/lib/utils';

export function BookingTabs({
  orgId,
  active,
  showFees,
}: {
  orgId: string;
  active: 'bookings' | 'fees';
  showFees: boolean;
}) {
  const tabs = [
    { key: 'bookings', label: 'Bookings', href: `/app/${orgId}/bookings` },
    ...(showFees ? [{ key: 'fees', label: 'Fees & invoices', href: `/app/${orgId}/bookings/fees` }] : []),
  ];
  return (
    <nav className="mb-6 flex gap-1 border-b" aria-label="Bookings sections">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.key === active ? 'page' : undefined}
          className={cn(
            '-mb-px border-b-2 px-3 py-2 text-sm',
            t.key === active
              ? 'border-primary font-medium text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
