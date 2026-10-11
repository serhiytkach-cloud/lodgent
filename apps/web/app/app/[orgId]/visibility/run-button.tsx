'use client';

import { Play } from 'lucide-react';
import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import type { ActionState } from '@/lib/api';
import { runCheck } from './actions';

export function RunButton({
  orgId,
  propertyId,
  disabledReason,
}: {
  orgId: string;
  propertyId: string;
  disabledReason: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<ActionState>(null);
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        disabled={pending || disabledReason !== null}
        title={disabledReason ?? undefined}
        onClick={() => startTransition(async () => setStatus(await runCheck(orgId, propertyId)))}
      >
        <Play /> {pending ? 'Starting…' : 'Run check now'}
      </Button>
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {status?.error ?? status?.message ?? disabledReason ?? ''}
      </p>
    </div>
  );
}
