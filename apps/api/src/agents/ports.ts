import type { AgentAttachment, FileKind, Schedule } from "@legallabs/contracts";
import type { Principal } from "../auth/auth.js";

/** Whether this person can reach an attachment. Walled and missing look the same, on purpose. */
export interface AttachmentPort {
  available(principal: Principal, attachment: { kind: FileKind; ref: string }): Promise<boolean>;
}

export interface SpaceInfo {
  external: boolean;
  /** Whether the requester administers it, so no approval is needed. */
  requesterIsAdmin: boolean;
  /** Whether the requester may invite into it at all. */
  mayInvite: boolean;
}

/** Spaces arrive with their own module; until then nothing can be shared into one. */
export interface SpacePort {
  info(principal: Principal, spaceId: string): Promise<SpaceInfo | null>;
}

export interface SchedulePort {
  upsert(id: string, schedule: Schedule): Promise<{ next_run_at: Date | null }>;
  pause(id: string, note: string): Promise<void>;
  resume(id: string): Promise<void>;
  remove(id: string): Promise<void>;
}

/** Shortens instructions to a description (class `summarise`). */
export interface Describer {
  describe(principal: Principal, title: string, instructions: string): Promise<string | null>;
}

/** Which sources this workspace has switched on, for import previews. */
export interface SourceCatalogue {
  status(principal: Principal, source: string): Promise<"ok" | "unknown_source" | "not_enabled">;
}

export const allAttachments: AttachmentPort = { available: async () => true };
export const noSpaces: SpacePort = { info: async () => null };
export const noSources: SourceCatalogue = { status: async () => "unknown_source" };

export type { AgentAttachment };
