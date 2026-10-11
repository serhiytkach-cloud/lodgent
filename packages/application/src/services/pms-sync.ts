import { type Clock, type PmsProperty, paymentModeFor, uniqueSlug } from '@lodgent/core';
import type { Database, NewProperty, PropertyRow, RoomTypeRow, TenantRepos } from '@lodgent/db';
import type { Logger } from 'pino';
import { systemActor } from '../context';
import type { PmsConnectionService } from './pms-connections';

/**
 * Applies PMS values to a row without clobbering hotel edits. A field is (re)written when it is
 * empty or still equals the value we imported last time; otherwise the hotel changed it and wins.
 * Returns the patch to apply and the new snapshot.
 */
export function mergeFromPms<T extends Record<string, unknown>>(
  current: Partial<T> | undefined,
  previousSnapshot: Record<string, unknown> | null | undefined,
  incoming: T,
): { patch: Partial<T>; snapshot: T } {
  const patch: Partial<T> = {};
  for (const key of Object.keys(incoming) as (keyof T & string)[]) {
    const value = incoming[key];
    const now = current?.[key];
    const before = previousSnapshot?.[key];
    const untouched =
      now === undefined || now === null || now === '' || JSON.stringify(now) === JSON.stringify(before);
    if (untouched && JSON.stringify(now) !== JSON.stringify(value)) patch[key] = value;
  }
  return { patch, snapshot: incoming };
}

function propertyFields(p: PmsProperty) {
  return {
    name: p.name,
    description: p.description,
    addressLine1: p.address.line1,
    addressLine2: p.address.line2,
    postalCode: p.address.postalCode,
    city: p.address.city,
    region: p.address.region,
    countryCode: p.address.countryCode,
    timeZone: p.timeZone,
    currency: p.currency,
  };
}

export interface SyncStats extends Record<string, number> {
  properties: number;
  propertiesCreated: number;
  roomTypes: number;
  ratePlans: number;
  policies: number;
}

/**
 * Idempotent import of properties, unit groups (room types), rate plans and cancellation policies.
 * Safe to run any number of times; rows missing from the PMS are archived, never deleted (holds and
 * reservations may reference them).
 */
export class PmsSyncService {
  constructor(
    private readonly deps: {
      db: Database;
      clock: Clock;
      connections: PmsConnectionService;
      logger: Logger;
      webhookEndpoint: string;
      defaultFeeBps: number;
      /** Called for each synced property (e.g. to map PMS data to attributes). */
      onPropertySynced?: (orgId: string, propertyId: string) => Promise<void>;
    },
  ) {}

  async syncOrganization(orgId: string): Promise<SyncStats> {
    const { db, clock, connections, logger } = this.deps;
    const stats: SyncStats = { properties: 0, propertiesCreated: 0, roomTypes: 0, ratePlans: 0, policies: 0 };
    const connection = await db.tenant(orgId, (r) => r.pmsConnection.get());
    if (!connection || connection.status === 'revoked') return stats;

    try {
      const client = await connections.clientFor(orgId);
      const pmsProperties = await client.listProperties();
      const synced: { propertyId: string; pmsPropertyId: string }[] = [];

      for (const pmsProperty of pmsProperties) {
        const [roomTypes, ratePlans] = await Promise.all([
          client.listRoomTypes(pmsProperty.pmsId),
          client.listRatePlans(pmsProperty.pmsId),
        ]);
        const slug = await db.system(({ identity }) =>
          uniqueSlug([pmsProperty.name, pmsProperty.address.city].filter(Boolean).join(' '), (s) =>
            identity.propertySlugExists(s),
          ),
        );
        const propertyId = await db.tenant(orgId, async (r) => {
          const property = await this.upsertProperty(r, connection.id, pmsProperty, slug, stats);
          const roomTypeIds = await this.syncRoomTypes(r, property.id, roomTypes, stats);
          await this.syncRatePlans(r, property.id, roomTypeIds, ratePlans, stats);
          return property.id;
        });
        synced.push({ propertyId, pmsPropertyId: pmsProperty.pmsId });
      }

      // Reservation webhooks: best effort. Without them the reconciliation job polls reservations.
      let webhookSubscriptionId = connection.webhookSubscriptionId;
      if (!webhookSubscriptionId && synced.length > 0) {
        try {
          webhookSubscriptionId = await client.subscribeWebhooks(
            this.deps.webhookEndpoint,
            synced.map((s) => s.pmsPropertyId),
          );
        } catch (error) {
          logger.warn({ err: error, orgId }, 'Apaleo webhook subscription failed; falling back to polling');
        }
      }

      await db.tenant(orgId, async (r) => {
        await r.pmsConnection.update(connection.id, {
          lastSyncAt: clock.now(),
          lastSyncStatus: 'ok',
          lastSyncError: null,
          lastSyncStats: stats,
          webhookSubscriptionId,
        });
        await r.audit.record({
          ...systemActor,
          action: 'pms.synced',
          entityType: 'pms_connection',
          entityId: connection.id,
          changes: stats,
        });
      });

      for (const s of synced) await this.deps.onPropertySynced?.(orgId, s.propertyId);
      return stats;
    } catch (error) {
      logger.error({ err: error, orgId }, 'PMS sync failed');
      await db.tenant(orgId, (r) =>
        r.pmsConnection.update(connection.id, {
          lastSyncAt: clock.now(),
          lastSyncStatus: 'failed',
          lastSyncError: error instanceof Error ? error.message.slice(0, 500) : 'Sync failed',
        }),
      );
      throw error;
    }
  }

  private async upsertProperty(
    r: TenantRepos,
    connectionId: string,
    pmsProperty: PmsProperty,
    slug: string,
    stats: SyncStats,
  ): Promise<PropertyRow> {
    stats.properties++;
    const incoming = propertyFields(pmsProperty);
    const existing = await r.properties.getByPmsId(pmsProperty.pmsId);
    if (!existing) {
      stats.propertiesCreated++;
      const values: NewProperty = {
        ...incoming,
        slug,
        feeBps: this.deps.defaultFeeBps,
        pmsConnectionId: connectionId,
        pmsPropertyId: pmsProperty.pmsId,
        pmsSnapshot: incoming,
      };
      const created = await r.properties.create(values);
      await r.audit.record({
        ...systemActor,
        action: 'property.imported',
        entityType: 'property',
        entityId: created.id,
        changes: { name: created.name, pmsPropertyId: pmsProperty.pmsId },
      });
      return created;
    }
    const { patch, snapshot } = mergeFromPms(
      existing as Partial<typeof incoming>,
      existing.pmsSnapshot,
      incoming,
    );
    const updated = await r.properties.update(existing.id, {
      ...patch,
      pmsSnapshot: snapshot,
      pmsConnectionId: connectionId,
    });
    return updated ?? existing;
  }

  private async syncRoomTypes(
    r: TenantRepos,
    propertyId: string,
    roomTypes: Awaited<ReturnType<Awaited<ReturnType<PmsConnectionService['clientFor']>>['listRoomTypes']>>,
    stats: SyncStats,
  ): Promise<Map<string, string>> {
    const now = this.deps.clock.now();
    const existing = await r.roomTypes.listForProperty(propertyId, { includeArchived: true });
    const byPmsId = new Map(
      existing.filter((x) => x.pmsId).map((x) => [x.pmsId!, x] as [string, RoomTypeRow]),
    );
    const ids = new Map<string, string>();
    for (const rt of roomTypes) {
      stats.roomTypes++;
      const incoming = {
        name: rt.name,
        description: rt.description,
        maxOccupancy: rt.maxOccupancy,
        unitCount: rt.unitCount,
      };
      const current = byPmsId.get(rt.pmsId);
      if (!current) {
        const row = await r.roomTypes.insert({
          ...incoming,
          propertyId,
          pmsId: rt.pmsId,
          code: rt.code,
          pmsSnapshot: incoming,
        });
        ids.set(rt.pmsId, row.id);
      } else {
        const { patch, snapshot } = mergeFromPms(
          current as Partial<typeof incoming>,
          current.pmsSnapshot,
          incoming,
        );
        await r.roomTypes.update(current.id, {
          ...patch,
          code: rt.code,
          pmsSnapshot: snapshot,
          archivedAt: null,
        });
        ids.set(rt.pmsId, current.id);
      }
    }
    for (const row of existing) {
      if (row.pmsId && !ids.has(row.pmsId) && !row.archivedAt)
        await r.roomTypes.update(row.id, { archivedAt: now });
    }
    return ids;
  }

  private async syncRatePlans(
    r: TenantRepos,
    propertyId: string,
    roomTypeIds: Map<string, string>,
    ratePlans: Awaited<ReturnType<Awaited<ReturnType<PmsConnectionService['clientFor']>>['listRatePlans']>>,
    stats: SyncStats,
  ): Promise<void> {
    const kept: string[] = [];
    for (const rp of ratePlans) {
      const roomTypeId = roomTypeIds.get(rp.pmsRoomTypeId);
      if (!roomTypeId) continue; // rate plan for a non-bedroom unit group
      let cancellationPolicyId: string | null = null;
      if (rp.cancellationPolicy) {
        stats.policies++;
        const policy = await r.policies.upsertPms(propertyId, 'cancellation', rp.cancellationPolicy.pmsId, {
          code: rp.cancellationPolicy.code,
          title: rp.cancellationPolicy.name ?? rp.cancellationPolicy.code ?? 'Cancellation policy',
          description: rp.cancellationPolicy.description,
        });
        cancellationPolicyId = policy.id;
      }
      stats.ratePlans++;
      kept.push(rp.pmsId);
      await r.ratePlans.upsertByPmsId(propertyId, rp.pmsId, {
        roomTypeId,
        code: rp.code,
        name: rp.name,
        description: rp.description,
        minGuarantee: rp.minGuarantee,
        paymentMode: paymentModeFor(rp.minGuarantee),
        channelCodes: rp.channelCodes,
        isBookable: rp.isBookable,
        cancellationPolicyId,
        includedServices: rp.includedServices,
        archivedAt: null,
      });
    }
    await r.ratePlans.archiveMissing(propertyId, kept, this.deps.clock.now());
  }
}
