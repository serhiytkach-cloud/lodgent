import type { Tx } from '../client';
import { agentClientRepo, agentLogRepo } from './agents';
import { bookingSystemRepo, holdSystemRepo } from './bookings';
import { catalogRepo } from './catalog';
import { identityRepo } from './identity';
import { pmsSystemRepo } from './pms';
import { taxonomyRepo } from './profile';
import { jobRepo, outboxDispatchRepo } from './queue';

/** Repositories for explicitly cross-tenant work. */
export function systemRepos(tx: Tx) {
  return {
    tx,
    identity: identityRepo(tx),
    agentClients: agentClientRepo(tx),
    agentLog: agentLogRepo(tx),
    holds: holdSystemRepo(tx),
    bookings: bookingSystemRepo(tx),
    catalog: catalogRepo(tx),
    pms: pmsSystemRepo(tx),
    taxonomy: taxonomyRepo(tx),
    outbox: outboxDispatchRepo(tx),
    jobs: jobRepo(tx),
  };
}

export type SystemRepos = ReturnType<typeof systemRepos>;
