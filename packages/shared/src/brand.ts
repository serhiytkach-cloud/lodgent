/**
 * Product naming lives here and nowhere else. "Lodgent" is a placeholder name:
 * to rename the product, change these values and the `@lodgent/` package scope
 * (a repo-wide find/replace; see CLAUDE.md).
 */
export const BRAND = {
  name: 'Lodgent',
  slug: 'lodgent',
  tagline: 'Agent-ready direct booking for independent hotels',
  /** Name the MCP server reports to clients. */
  mcpServerName: 'lodgent',
  /** Prefix for partner API keys, e.g. `lodgent_live_...`. */
  apiKeyPrefix: 'lodgent',
  /** Cookie that carries the dashboard session on the web origin. */
  sessionCookie: 'lodgent_session',
  /** Default sender for transactional email. */
  defaultEmailFrom: 'Lodgent Bookings <bookings@lodgent.local>',
} as const;
