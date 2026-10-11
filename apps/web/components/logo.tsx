import { BRAND } from '@lodgent/shared';
import { cn } from '@/lib/utils';

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2 font-semibold tracking-tight', className)}>
      <svg viewBox="0 0 24 24" className="size-6 text-primary" aria-hidden="true">
        <rect x="2" y="2" width="20" height="20" rx="6" fill="currentColor" />
        <path
          d="M8 6.5v11h8"
          stroke="white"
          strokeWidth="2.2"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="16" cy="8" r="1.6" fill="white" />
      </svg>
      <span>{BRAND.name}</span>
    </span>
  );
}
