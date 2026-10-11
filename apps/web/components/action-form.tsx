'use client';

import { createContext, type ReactNode, useActionState, useContext } from 'react';
import type { ActionState } from '@/lib/api';
import { Button } from './ui/button';
import { Alert } from './ui/misc';

const ActionStateContext = createContext<ActionState>(null);

export function useFormActionState(): ActionState {
  return useContext(ActionStateContext);
}

/**
 * A form bound to a Server Action that returns `ActionState`. Children are plain (server-renderable)
 * markup; `<Field name="…">` picks up per-field errors from context.
 */
export function ActionForm({
  action,
  children,
  submitLabel = 'Save',
  pendingLabel = 'Saving…',
  className,
  submitVariant,
  resetOnSuccess = false,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  children: ReactNode;
  submitLabel?: string;
  pendingLabel?: string;
  className?: string;
  submitVariant?: 'default' | 'outline' | 'secondary';
  resetOnSuccess?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  return (
    <ActionStateContext.Provider value={state}>
      <form
        action={formAction}
        className="grid gap-4"
        key={resetOnSuccess && state?.ok ? String(Date.now()) : undefined}
      >
        <div className={className ?? 'grid gap-4'}>{children}</div>
        {state?.error ? <Alert variant="error">{state.error}</Alert> : null}
        {state?.ok && state.message ? <Alert variant="success">{state.message}</Alert> : null}
        <div>
          <Button type="submit" disabled={pending} variant={submitVariant}>
            {pending ? pendingLabel : submitLabel}
          </Button>
        </div>
      </form>
    </ActionStateContext.Provider>
  );
}

export function FieldError({ name }: { name: string }) {
  const state = useFormActionState();
  const message = state?.fieldErrors?.[name];
  return message ? <p className="text-xs text-destructive">{message}</p> : null;
}
