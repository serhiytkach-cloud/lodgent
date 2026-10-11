import type { Database } from '@lodgent/db';
import { assertCan, type OrgContext } from '../context';

export class AuditService {
  constructor(private readonly db: Database) {}

  async list(ctx: OrgContext, options: { limit: number; before?: Date }) {
    assertCan(ctx, 'audit.read');
    const rows = await this.db.tenant(ctx.orgId, (r) => r.audit.list(options));
    return rows.map((row) => ({
      id: row.id,
      actorType: row.actorType,
      actorEmail: row.actorEmail,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      changes: row.changes ?? null,
      createdAt: row.createdAt.toISOString(),
    }));
  }
}
