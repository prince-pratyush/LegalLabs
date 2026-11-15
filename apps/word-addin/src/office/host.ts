import type { Anchor } from "../edits/anchor.js";

export type Scope = "selection" | "document";

/** What this Word can do; older hosts get a pane that copies instead of editing. */
export type Capabilities = {
  /** Turning track changes on (WordApi 1.4). Without it the pane never edits. */
  tracked: boolean;
  /** Comments on a range (WordApi 1.4). */
  comments: boolean;
};

type IsSetSupported = (name: string, version: string) => boolean;

export function capabilitiesOf(isSetSupported: IsSetSupported): Capabilities {
  const at = (version: string) => {
    try {
      return isSetSupported("WordApi", version);
    } catch {
      return false;
    }
  };
  return { tracked: at("1.4"), comments: at("1.4") };
}

export type Edit = {
  anchor: Anchor;
  before: string;
  after: string;
  /** Added as a Word comment on the changed text when set. */
  comment?: string;
};

export type ApplyResult =
  | { ok: true }
  /** The text moved or changed since the suggestion was made, so nothing was touched. */
  | { ok: false; reason: "anchor_failed" | "unsupported" };

export type ScopeText = { text: string; paragraphs: string[] };

/** Everything the pane asks of Word, so the UI is tested without Office. */
export interface WordHost {
  capabilities: Capabilities;
  read(scope: Scope): Promise<ScopeText>;
  /** The whole document as .docx bytes, for reviews that need the original file. */
  file(): Promise<Uint8Array>;
  title(): string;
  /** Selects the first place this text appears; false when it isn't there. */
  select(text: string): Promise<boolean>;
  /** Track changes on (when `track`), then the smallest word-level edit. */
  apply(edit: Edit, track: boolean): Promise<ApplyResult>;
  /**
   * Rewrites whole paragraphs, indexed as `read(scope).paragraphs` returned them,
   * as tracked changes when `track`. Returns how many changed.
   */
  rewrite(
    scope: Scope,
    edits: readonly { index: number; text: string }[],
    track: boolean,
  ): Promise<number>;
  onSelectionChange(listener: () => void): () => void;
  /** Opens a LegalLabs page, such as the document viewer, in the user's browser. */
  openInBrowser(url: string): void;
}
