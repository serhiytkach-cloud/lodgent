import { and, eq, isNull } from 'drizzle-orm';
import type { Tx } from '../client';
import { agentClients, agentEvents, agentQueries } from '../schema';

export type AgentClientRow = typeof agentClients.$inferSelect;
export type NewAgentQuery = typeof agentQueries.$inferInsert;
export type NewAgentEvent = typeof agentEvents.$inferInsert;

export function agentClientRepo(tx: Tx) {
  return {
    async create(values: { name: string; contactEmail: string | null; keyPrefix: string; keyHash: string }) {
      const [row] = await tx.insert(agentClients).values(values).returning();
      return row!;
    },
    async findActiveByHash(keyHash: string): Promise<AgentClientRow | undefined> {
      const [row] = await tx
        .select()
        .from(agentClients)
        .where(and(eq(agentClients.keyHash, keyHash), isNull(agentClients.revokedAt)));
      return row;
    },
    async touch(id: string, now: Date) {
      await tx.update(agentClients).set({ lastUsedAt: now }).where(eq(agentClients.id, id));
    },
    async list() {
      return tx.select().from(agentClients).orderBy(agentClients.createdAt);
    },
    async revoke(id: string, now: Date) {
      const [row] = await tx
        .update(agentClients)
        .set({ revokedAt: now })
        .where(and(eq(agentClients.id, id), isNull(agentClients.revokedAt)))
        .returning();
      return row;
    },
  };
}

/** Agent request log and per-hotel funnel events (written in the system context). */
export function agentLogRepo(tx: Tx) {
  return {
    async insertQuery(values: NewAgentQuery): Promise<string> {
      const [row] = await tx.insert(agentQueries).values(values).returning({ id: agentQueries.id });
      return row!.id;
    },
    async insertEvents(values: NewAgentEvent[]): Promise<void> {
      if (values.length > 0) await tx.insert(agentEvents).values(values);
    },
  };
}
