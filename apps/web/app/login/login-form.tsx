'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form';
import { Alert } from '@/components/ui/misc';
import { devLogin } from './actions';

export function DevLoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState(devLogin, null);
  return (
    <form action={action} className="grid gap-4">
      <input type="hidden" name="next" value={next} />
      <Field label="Work email" htmlFor="email" error={state?.fieldErrors?.email}>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          placeholder="you@hotel.com"
        />
      </Field>
      <Field label="Your name" htmlFor="name" hint="Optional">
        <Input id="name" name="name" autoComplete="name" />
      </Field>
      {state?.error && !state.fieldErrors ? <Alert variant="error">{state.error}</Alert> : null}
      <Button type="submit" disabled={pending}>
        {pending ? 'Signing in…' : 'Continue'}
      </Button>
    </form>
  );
}
