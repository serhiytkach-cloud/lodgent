'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const TABS = [
  { href: '', label: 'Profile' },
  { href: '/rooms', label: 'Rooms & rates' },
  { href: '/publish', label: 'Publish' },
  { href: '/details', label: 'Details' },
];

export function PropertyTabs({ base }: { base: string }) {
  const pathname = usePathname();
  return (
    <div className="flex gap-1 overflow-x-auto border-b">
      {TABS.map((tab) => {
        const href = `${base}${tab.href}`;
        const active = tab.href === '' ? pathname === base : pathname.startsWith(href);
        return (
          <Link
            key={tab.href}
            href={href}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm whitespace-nowrap',
              active
                ? 'border-primary font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
