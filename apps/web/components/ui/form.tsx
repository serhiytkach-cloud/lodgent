import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { FieldError } from '../action-form';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'flex h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60',
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'flex min-h-20 w-full rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60',
        className,
      )}
      {...props}
    />
  );
}

export function Select({ className, ...props }: ComponentProps<'select'>) {
  return (
    <select
      className={cn(
        'flex h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60',
        className,
      )}
      {...props}
    />
  );
}

export function Label({ className, ...props }: ComponentProps<'label'>) {
  // biome-ignore lint/a11y/noLabelWithoutControl: consumers pass htmlFor or wrap the control.
  return <label className={cn('text-sm font-medium leading-none', className)} {...props} />;
}

/**
 * Label + control + hint. Inside an `<ActionForm>`, pass the field's `name` to show its validation
 * error from the Server Action; outside one, pass `error` directly.
 */
export function Field({
  label,
  htmlFor,
  name,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  htmlFor: string;
  name?: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('grid gap-1.5', className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {name ? <FieldError name={name} /> : null}
    </div>
  );
}

export function Checkbox({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      type="checkbox"
      className={cn('size-4 rounded border-input accent-primary', className)}
      {...props}
    />
  );
}
