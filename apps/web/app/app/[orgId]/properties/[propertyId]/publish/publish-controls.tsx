'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/misc';
import type { ActionState } from '@/lib/api';
import { setPublished } from '../profile-actions';

export function PublishButton({
  orgId,
  propertyId,
  published,
  canPublish,
}: {
  orgId: string;
  propertyId: string;
  published: boolean;
  canPublish: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<ActionState>(null);
  const toggle = () =>
    startTransition(async () => {
      if (published && !window.confirm('Hide this hotel from AI agents? Existing bookings are not affected.'))
        return;
      setStatus(await setPublished(orgId, propertyId, !published));
    });
  return (
    <div className="grid gap-3">
      <div>
        {published ? (
          <Button variant="outline" onClick={toggle} disabled={pending}>
            {pending ? 'Unpublishing…' : 'Unpublish'}
          </Button>
        ) : (
          <Button onClick={toggle} disabled={pending || !canPublish}>
            {pending ? 'Publishing…' : 'Publish to AI agents'}
          </Button>
        )}
      </div>
      <div aria-live="polite">
        {status?.error ? <Alert variant="error">{status.error}</Alert> : null}
        {status?.ok && status.message ? <Alert variant="success">{status.message}</Alert> : null}
      </div>
    </div>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? 'Copied' : label}
    </Button>
  );
}
