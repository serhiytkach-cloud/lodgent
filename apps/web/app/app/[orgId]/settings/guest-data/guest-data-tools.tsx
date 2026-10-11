'use client';

import { Download, Trash2 } from 'lucide-react';
import { useActionState, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox, Field, Input, Label } from '@/components/ui/form';
import { Alert, Badge, Table, Td, Th } from '@/components/ui/misc';
import { formatDate } from '@/lib/utils';
import { type EraseState, type ExportState, eraseGuestData, exportGuestData } from './actions';

function saveFile(file: { name: string; json: string }) {
  const url = URL.createObjectURL(new Blob([file.json], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function ExportGuestData({ orgId }: { orgId: string }) {
  const [state, action, pending] = useActionState<ExportState, FormData>(
    exportGuestData.bind(null, orgId),
    null,
  );
  // Download as soon as an export arrives.
  useEffect(() => {
    if (state?.file) saveFile(state.file);
  }, [state]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Export a guest’s data</CardTitle>
        <CardDescription>
          Downloads everything we hold about a guest in this organization as JSON: their bookings with stay,
          property, amounts, status, contact details and timestamps. Use it to answer an access request.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="grid gap-4">
          <Field
            label="Guest email"
            htmlFor="export-email"
            error={state?.fieldErrors?.email}
            hint="The address the guest booked with. Matching ignores upper/lower case."
          >
            <Input id="export-email" name="email" type="email" autoComplete="off" required />
          </Field>
          {state?.error ? <Alert variant="error">{state.error}</Alert> : null}
          {state?.ok && state.message ? (
            <Alert variant="success">
              {state.message}{' '}
              {state.file ? (
                <button
                  type="button"
                  className="font-medium underline"
                  onClick={() => state.file && saveFile(state.file)}
                >
                  Download again
                </button>
              ) : null}
            </Alert>
          ) : null}
          <div>
            <Button type="submit" variant="outline" disabled={pending}>
              <Download /> {pending ? 'Exporting…' : 'Export JSON'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export function EraseGuestData({ orgId }: { orgId: string }) {
  const [state, action, pending] = useActionState<EraseState, FormData>(
    eraseGuestData.bind(null, orgId),
    null,
  );
  const [draft, setDraft] = useState<{ email: string; reason: string } | null>(null);
  // What was last reviewed, to refill the form after a failed attempt (cleared after a success).
  const [last, setLast] = useState({ email: '', reason: '' });
  const [understood, setUnderstood] = useState(false);
  const refill = state?.ok ? { email: '', reason: '' } : last;

  // Back to the first step once the erasure has run.
  useEffect(() => {
    if (state) {
      setDraft(null);
      setUnderstood(false);
    }
  }, [state]);

  const result = state?.result;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Erase a guest’s data</CardTitle>
        <CardDescription>
          Permanently removes the guest’s name, email, phone and requests from all their bookings in this
          organization and cancels confirmation emails not yet sent. Amounts, dates and booking references
          stay for your accounts. This cannot be undone.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {draft ? (
          <form action={action} className="grid gap-4">
            <input type="hidden" name="email" value={draft.email} />
            <input type="hidden" name="reason" value={draft.reason} />
            <Alert variant="warning" title={`Erase all personal data for ${draft.email}?`}>
              <p>
                Every booking in this organization made with this email loses the guest’s details for good.
                Bookings still in checkout are skipped; run the erasure again later for those.
              </p>
              <p className="mt-2">
                The reservation in your PMS and payment records in your Stripe account are not changed. Handle
                those there if the request covers them.
              </p>
            </Alert>
            <div className="flex items-center gap-2">
              <Checkbox
                id="erase-understood"
                checked={understood}
                onChange={(e) => setUnderstood(e.target.checked)}
              />
              <Label htmlFor="erase-understood">I understand this cannot be undone</Label>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="destructive" disabled={!understood || pending}>
                <Trash2 /> {pending ? 'Erasing…' : 'Erase permanently'}
              </Button>
              <Button type="button" variant="outline" disabled={pending} onClick={() => setDraft(null)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <form
            className="grid gap-4 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              const values = {
                email: String(data.get('email') ?? '').trim(),
                reason: String(data.get('reason') ?? '').trim(),
              };
              setLast(values);
              setDraft(values);
            }}
          >
            <Field label="Guest email" htmlFor="erase-email" error={state?.fieldErrors?.email}>
              <Input
                id="erase-email"
                name="email"
                type="email"
                autoComplete="off"
                required
                defaultValue={refill.email}
              />
            </Field>
            <Field
              label="Reason (optional)"
              htmlFor="erase-reason"
              error={state?.fieldErrors?.reason}
              hint="Kept in the audit log, e.g. “guest request by email”. Avoid contact details."
            >
              <Input
                id="erase-reason"
                name="reason"
                maxLength={200}
                autoComplete="off"
                defaultValue={refill.reason}
              />
            </Field>
            <div className="sm:col-span-2">
              <Button type="submit" variant="outline">
                Review erasure…
              </Button>
            </div>
          </form>
        )}

        {state?.error ? <Alert variant="error">{state.error}</Alert> : null}
        {state?.ok && state.message ? <Alert variant="success">{state.message}</Alert> : null}
        {result?.warnings.map((warning) => (
          <Alert key={warning} variant="warning">
            {warning}
          </Alert>
        ))}
        {result && result.bookings.length > 0 ? (
          <Table>
            <thead>
              <tr>
                <Th>Booking</Th>
                <Th>Hotel</Th>
                <Th>Stay</Th>
                <Th>Result</Th>
              </tr>
            </thead>
            <tbody>
              {result.bookings.map((b) => (
                <tr key={b.id}>
                  <Td className="font-mono text-xs">{b.reference}</Td>
                  <Td>{b.propertyName}</Td>
                  <Td>
                    {formatDate(b.arrival)} – {formatDate(b.departure)}
                  </Td>
                  <Td>
                    {b.result === 'erased' ? (
                      <Badge variant="success">Erased</Badge>
                    ) : (
                      <Badge variant="warning">In checkout, try later</Badge>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : null}
        {result ? (
          <p className="text-xs text-muted-foreground">
            Audit reference <span className="font-mono">{result.subject.ref}</span>. The audit log records
            this reference, never the email.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
