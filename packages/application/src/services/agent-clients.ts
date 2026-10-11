import type { Clock } from '@lodgent/core';
import type { Database } from '@lodgent/db';
import { BRAND } from '@lodgent/shared';
import { hashToken, newToken } from './members';

interface CachedClient {
  value: { id: string; name: string; rateLimitPerMinute: number | null } | null;
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000;
const TOUCH_INTERVAL_MS = 5 * 60_000;

/** Partner API keys for agent attribution and higher rate limits. */
export class AgentClientService {
  private readonly cache = new Map<string, CachedClient>();
  private readonly touched = new Map<string, number>();

  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  /** Creates a partner and returns its API key. The key is shown once and never stored. */
  async create(input: { name: string; contactEmail?: string | null }) {
    const key = `${BRAND.apiKeyPrefix}_live_${newToken(32)}`;
    const row = await this.db.system(({ agentClients }) =>
      agentClients.create({
        name: input.name,
        contactEmail: input.contactEmail ?? null,
        keyPrefix: key.slice(0, 18),
        keyHash: hashToken(key),
      }),
    );
    return { id: row.id, name: row.name, apiKey: key };
  }

  async verify(key: string) {
    const hash = hashToken(key);
    const now = this.clock.now().getTime();
    const cached = this.cache.get(hash);
    if (cached && cached.expiresAt > now) return cached.value;

    const row = await this.db.system(({ agentClients }) => agentClients.findActiveByHash(hash));
    const value = row ? { id: row.id, name: row.name, rateLimitPerMinute: row.rateLimitPerMinute } : null;
    this.cache.set(hash, { value, expiresAt: now + CACHE_TTL_MS });
    if (row && (this.touched.get(row.id) ?? 0) < now - TOUCH_INTERVAL_MS) {
      this.touched.set(row.id, now);
      await this.db.system(({ agentClients }) => agentClients.touch(row.id, this.clock.now()));
    }
    return value;
  }

  async revoke(id: string) {
    this.cache.clear();
    return this.db.system(({ agentClients }) => agentClients.revoke(id, this.clock.now()));
  }

  async list() {
    return this.db.system(({ agentClients }) => agentClients.list());
  }
}
