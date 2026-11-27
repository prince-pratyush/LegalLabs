import { z } from "zod";
import { FactDate } from "./facts.js";
import { Text } from "./playbook.js";

// Horizon scanning: a person's standing watch over public sources. A scan and everything it
// finds are its owner's alone.

export const HORIZON_LIMITS = {
  /** Scans one workspace can hold. */
  scans: 100,
  sources: 20,
  /** How far before a scan was made its first day can be. */
  from_days: 28,
  purpose_chars: 2000,
  name_chars: 200,
  tag_chars: 100,
  tags: 20,
  page_size: 50,
  /** Items older than this show as archived. */
  keep_days: 365,
} as const;

export const HorizonJurisdiction = z.enum(["US", "UK"]);
export type HorizonJurisdiction = z.infer<typeof HorizonJurisdiction>;

export const HORIZON_SOURCES = [
  { id: "fr", name: "Federal Register", jurisdiction: "US" },
  { id: "ecfr", name: "eCFR changes", jurisdiction: "US" },
  { id: "uk_legislation", name: "New UK legislation", jurisdiction: "UK" },
] as const;
export const HorizonSource = z.enum(["fr", "ecfr", "uk_legislation"]);
export type HorizonSource = z.infer<typeof HorizonSource>;

export const HorizonRelevance = z.enum(["high", "medium", "low"]);
export type HorizonRelevance = z.infer<typeof HorizonRelevance>;

const tags = z.array(Text(HORIZON_LIMITS.tag_chars).pipe(z.string().min(1))).max(20);
const fields = {
  name: Text(HORIZON_LIMITS.name_chars).pipe(z.string().min(1)),
  purpose: Text(HORIZON_LIMITS.purpose_chars).pipe(z.string().min(1)),
  jurisdictions: z.array(HorizonJurisdiction).max(2),
  industries: tags,
  topics: tags,
  sources: z.array(HorizonSource).min(1).max(HORIZON_LIMITS.sources),
  from_date: FactDate,
  /** Items below this are shown collapsed; none are dropped. */
  relevance_floor: HorizonRelevance,
};

export const HorizonScanCreate = z.strictObject({
  ...fields,
  jurisdictions: fields.jurisdictions.default([]),
  industries: fields.industries.default([]),
  topics: fields.topics.default([]),
  relevance_floor: fields.relevance_floor.default("low"),
});
export type HorizonScanCreate = z.infer<typeof HorizonScanCreate>;

export const HorizonScanPatch = z.strictObject(fields).partial();
export type HorizonScanPatch = z.infer<typeof HorizonScanPatch>;

export const HorizonSettings = z.strictObject({ enabled: z.boolean() });

export interface HorizonScan {
  id: string;
  name: string;
  purpose: string;
  jurisdictions: HorizonJurisdiction[];
  industries: string[];
  topics: string[];
  sources: HorizonSource[];
  from_date: string;
  relevance_floor: HorizonRelevance;
  /** Degraded while any source has failed three refreshes in a row. */
  health: "ok" | "degraded";
  failing_sources: HorizonSource[];
  /** Set when refreshing stopped because the owner could no longer run it. */
  stopped: boolean;
  items: number;
  unread: number;
  high: number;
  last_refresh_at: string | null;
  next_refresh_at: string | null;
  created_at: string;
}

export interface HorizonItemState {
  read: boolean;
  starred: boolean;
  archived: boolean;
}

export interface HorizonItem {
  id: string;
  scan_id: string;
  development: string;
  summary: string;
  relevance: HorizonRelevance;
  explanation: string;
  type: string;
  industries: string[];
  topics: string[];
  jurisdictions: HorizonJurisdiction[];
  sources: HorizonSource[];
  published_at: string;
  source_url: string;
  state: HorizonItemState;
}
