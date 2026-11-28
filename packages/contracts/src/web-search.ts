import { z } from "zod";

/** Web search as a source: off until an administrator turns it on. */

export const WEB_SOURCE_ID = "web";
/** All that leaves for the search service: this much of what was typed. */
export const WEB_QUERY_CHARS = 400;

export const WebSourceFilter = z.strictObject({
  recency_days: z.number().int().min(1).max(3650).optional(),
});

/** What people are told before their words leave the workspace. */
export const webSearchNotice = (host: string) =>
  `Web search sends the text of your question (up to ${WEB_QUERY_CHARS} characters) to ${host}, ` +
  "then reads pages from the sites it returns. Attached files, @mentions and earlier messages " +
  "are not sent. Leave out client names and other confidential facts.";

export const WebSearchSwitch = z.strictObject({ enabled: z.boolean() });
export const WebMatterSwitch = z.strictObject({ blocked: z.boolean() });

export interface WebSearchSettings {
  /** Whether the operator has set up a search service. */
  configured: boolean;
  enabled: boolean;
  provider_host: string | null;
  can_manage: boolean;
  /** Listed for those who can manage them. */
  blocked_matter_ids: string[];
}
