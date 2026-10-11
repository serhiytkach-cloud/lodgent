import type { Tx } from '../client';
import { agentClientRepo } from './agents';
import { identityRepo } from './identity';
import { pmsSystemRepo } from './pms';
import { jobRepo, outboxDispatchRepo } from './queue';

/** Repositories for explicitly cross-tenant work. */
export function systemRepos(tx: Tx) {
  return {
    tx,
    identity: identityRepo(tx),
    agentClients: agentClientRepo(tx),
    pms: pmsSystemRepo(tx),
    outbox: outboxDispatchRepo(tx),
    jobs: jobRepo(tx),
  };
}

export type SystemRepos = ReturnType<typeof systemRepos>;
