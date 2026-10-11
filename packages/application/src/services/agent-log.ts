import type { Database, NewAgentEvent, NewAgentQuery } from '@lodgent/db';
import type { Logger } from 'pino';

/** Who is calling the agent surface. Carries no guest data. */
export interface AgentCaller {
  partnerId: string | null;
  channel: 'mcp' | 'rest';
  clientName: string | null;
  utm: { source: string | null; medium: string | null; campaign: string | null };
}

export const anonymousRestCaller: AgentCaller = {
  partnerId: null,
  channel: 'rest',
  clientName: null,
  utm: { source: null, medium: null, campaign: null },
};

/**
 * Strips anything that could identify a person from a short free-text field before it is logged:
 * email addresses, phone-like and other long digit runs, and URLs. Callers log codes rather than
 * text wherever they can; this is the safety net for the few text fields we keep (destination).
 */
export function redactForLog(text: string | null | undefined, max = 60): string | null {
  if (!text) return null;
  const cleaned = text
    .replace(/[^\s@]+@[^\s@]+/g, '[email]')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/\+?\d[\d\s().-]{5,}\d/g, '[number]')
    .replace(/\d{3,}/g, '[number]')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, max) || null;
}

type QueryFields = Omit<
  NewAgentQuery,
  'agentClientId' | 'channel' | 'clientName' | 'utmSource' | 'utmMedium' | 'utmCampaign'
>;

/** Writes the agent request log and per-hotel funnel events. Never fails the request it describes. */
export class AgentLog {
  constructor(
    private readonly db: Database,
    private readonly logger: Logger,
  ) {}

  async record(
    caller: AgentCaller,
    query: QueryFields,
    events: Omit<NewAgentEvent, 'queryId' | 'agentClientId' | 'channel' | 'clientName'>[] = [],
  ): Promise<string | null> {
    try {
      return await this.db.system(async ({ agentLog }) => {
        const queryId = await agentLog.insertQuery({
          ...query,
          // Free text from the agent: masked like the other text fields (it could carry contact details).
          destination: redactForLog(query.destination),
          agentClientId: caller.partnerId,
          channel: caller.channel,
          clientName: redactForLog(caller.clientName),
          utmSource: redactForLog(caller.utm.source),
          utmMedium: redactForLog(caller.utm.medium),
          utmCampaign: redactForLog(caller.utm.campaign),
        });
        await agentLog.insertEvents(
          events.map((e) => ({
            ...e,
            queryId,
            agentClientId: caller.partnerId,
            channel: caller.channel,
            clientName: redactForLog(caller.clientName),
          })),
        );
        return queryId;
      });
    } catch (error) {
      this.logger.warn({ err: error, tool: query.tool }, 'failed to record agent activity');
      return null;
    }
  }
}
