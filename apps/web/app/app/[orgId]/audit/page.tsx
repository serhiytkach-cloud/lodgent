import { Card } from '@/components/ui/card';
import { EmptyState, PageHeader, Table, Td, Th } from '@/components/ui/misc';
import { api } from '@/lib/api';
import type { AuditEntry } from '@/lib/types';
import { formatDateTime } from '@/lib/utils';

function summarize(changes: AuditEntry['changes']): string {
  if (!changes) return '';
  return Object.entries(changes)
    .map(([key, value]) => {
      if (value && typeof value === 'object' && 'to' in value)
        return `${key} → ${JSON.stringify((value as { to: unknown }).to)}`;
      return `${key}: ${JSON.stringify(value)}`;
    })
    .join(', ')
    .slice(0, 240);
}

export default async function AuditPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { entries } = await api<{ entries: AuditEntry[] }>(`/v1/orgs/${orgId}/audit-log?limit=200`);
  return (
    <>
      <PageHeader title="Audit log" description="Every change made in this organization, newest first." />
      {entries.length === 0 ? (
        <EmptyState title="Nothing yet" />
      ) : (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Who</Th>
                <Th>What</Th>
                <Th>Details</Th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <Td className="whitespace-nowrap text-muted-foreground">{formatDateTime(e.createdAt)}</Td>
                  <Td>{e.actorType === 'system' ? 'System' : (e.actorEmail ?? 'Former member')}</Td>
                  <Td className="font-mono text-xs">{e.action}</Td>
                  <Td
                    className="max-w-md truncate text-xs text-muted-foreground"
                    title={summarize(e.changes)}
                  >
                    {summarize(e.changes)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </>
  );
}
