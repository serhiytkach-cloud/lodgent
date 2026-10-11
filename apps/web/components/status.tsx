import { Badge } from './ui/misc';

export function PropertyStatusBadge({ status }: { status: 'draft' | 'published' | 'unpublished' }) {
  if (status === 'published') return <Badge variant="success">Published</Badge>;
  if (status === 'unpublished') return <Badge variant="warning">Unpublished</Badge>;
  return <Badge variant="secondary">Draft</Badge>;
}

const BOOKING_STATUS = {
  pending_payment: { label: 'Awaiting payment', variant: 'secondary' },
  reserving: { label: 'Reserving', variant: 'warning' },
  confirmed: { label: 'Confirmed', variant: 'success' },
  failed: { label: 'Failed', variant: 'destructive' },
  cancelled: { label: 'Cancelled', variant: 'outline' },
} as const;

export const BOOKING_STATUSES = Object.entries(BOOKING_STATUS).map(([value, s]) => ({
  value,
  label: s.label,
}));

export function BookingStatusBadge({ status }: { status: keyof typeof BOOKING_STATUS }) {
  const s = BOOKING_STATUS[status];
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

const FEE_STATUS = {
  collected: { label: 'Collected', variant: 'success' },
  pending: { label: 'To invoice', variant: 'secondary' },
  invoiced: { label: 'Invoiced', variant: 'default' },
  void: { label: 'Waived', variant: 'outline' },
} as const;

export function FeeStatusBadge({ status }: { status: keyof typeof FEE_STATUS | null }) {
  if (!status) return <span className="text-muted-foreground">—</span>;
  const s = FEE_STATUS[status];
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

const INVOICE_STATUS = {
  draft: { label: 'Preparing', variant: 'secondary' },
  open: { label: 'Open', variant: 'warning' },
  paid: { label: 'Paid', variant: 'success' },
  void: { label: 'Void', variant: 'outline' },
  uncollectible: { label: 'Uncollectible', variant: 'destructive' },
} as const;

export function InvoiceStatusBadge({ status }: { status: keyof typeof INVOICE_STATUS }) {
  const s = INVOICE_STATUS[status];
  return <Badge variant={s.variant}>{s.label}</Badge>;
}
