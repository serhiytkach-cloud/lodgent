'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form';
import { Alert } from '@/components/ui/misc';
import { createOrganization } from './actions';

export function OnboardingForm() {
  const [state, action, pending] = useActionState(createOrganization, null);
  return (
    <form action={action} className="grid gap-4">
      <Field
        label="Organization name"
        htmlFor="name"
        error={state?.fieldErrors?.name}
        hint="Your hotel or hotel group"
      >
        <Input id="name" name="name" required minLength={2} placeholder="Casa Azul Hotels" />
      </Field>
      <Field
        label="Billing email"
        htmlFor="billingEmail"
        error={state?.fieldErrors?.billingEmail}
        hint="Where monthly fee invoices go"
      >
        <Input id="billingEmail" name="billingEmail" type="email" placeholder="accounts@hotel.com" />
      </Field>
      {state?.error && !state.fieldErrors ? <Alert variant="error">{state.error}</Alert> : null}
      <Button type="submit" disabled={pending}>
        {pending ? 'Creating…' : 'Create organization'}
      </Button>
    </form>
  );
}
