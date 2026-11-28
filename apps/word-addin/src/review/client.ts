import { type Api, ApiError } from "@legallabs/addin";
import {
  estimatePages,
  PLAYBOOK_LIMITS,
  type PlaybookSummary,
  type Review,
  type ReviewRequest,
} from "@legallabs/contracts";
import type { Decision } from "../cards/CardList.js";
import type { WordHost } from "../office/host.js";

export type Paper = "ours" | "theirs";
export type Mode = "standard" | "in_depth" | "redline_only";

const POLL_MS = 2_000;
const MAX_WAIT_MS = 15 * 60_000;

export type Size = { ok: true; long: boolean } | { ok: false };

/** Spec WRD-006: refused above the character limit; warned past 100 pages. */
export const sizeOf = (chars: number): Size =>
  chars > PLAYBOOK_LIMITS.doc_chars
    ? { ok: false }
    : { ok: true, long: estimatePages(chars) > 100 };

/** Published playbooks the user can run; null when this server has no playbook reviews yet. */
export async function listPlaybooks(api: Api): Promise<PlaybookSummary[] | null> {
  try {
    const body = await api.get<{ playbooks: PlaybookSummary[] }>(
      "/api/v1/playbooks?filter[status]=published",
    );
    return body.playbooks;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/** Uploads the open file as it is now, so the review and its anchors match what Word shows. */
async function uploadVersion(api: Api, host: WordHost): Promise<string> {
  const bytes = await host.file();
  const form = new FormData();
  form.append("file", new File([bytes], `${host.title()}.docx`));
  const { document } = await api.upload<{ document: { version_id: string } }>(
    "/api/v1/documents",
    form,
  );
  return document.version_id;
}

export async function startReview(
  api: Api,
  host: WordHost,
  playbookId: string,
  options: { party: string; paper: Paper; mode: Mode },
): Promise<string> {
  const request: ReviewRequest = {
    document_version_id: await uploadVersion(api, host),
    ...options,
    scope: "all",
    surface: "word",
  };
  const { review_id } = await api.post<{ run_id: string; review_id: string }>(
    `/api/v1/playbooks/${playbookId}/reviews`,
    request,
  );
  return review_id;
}

type Wait = (ms: number) => Promise<void>;
const sleep: Wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until the review stops; a cancelled review keeps the findings it finished. */
export async function waitForReview(
  api: Api,
  reviewId: string,
  onUpdate: (review: Review) => void,
  wait: Wait = sleep,
  /** False once nobody is waiting, e.g. the pane moved on; polling then stops. */
  live: () => boolean = () => true,
): Promise<Review> {
  for (let waited = 0; ; waited += POLL_MS) {
    if (!live()) throw new ApiError(499, "STOPPED", "Stopped waiting for the review.");
    const { review } = await api.get<{ review: Review }>(`/api/v1/reviews/${reviewId}`);
    onUpdate(review);
    if (review.status === "failed") throw new ApiError(500, "REVIEW_FAILED", "The review failed.");
    if (review.status === "done" || review.status === "cancelled") return review;
    // "planned", "running" and "verifying" all mean keep waiting.
    if (waited >= MAX_WAIT_MS) throw new ApiError(504, "TIMEOUT", "The review is taking too long.");
    await wait(POLL_MS);
  }
}

/** Re-runs one rule against the document as it is now (spec WRD-004-b). */
export async function rerunRule(api: Api, host: WordHost, reviewId: string, ruleId: string) {
  await api.post(`/api/v1/reviews/${reviewId}/rules/${ruleId}/rerun`, {
    document_version_id: await uploadVersion(api, host),
  });
}

/** Records the decision with the server, so web, exports and Word agree on what was applied. */
export const reportDecision = (api: Api, reviewId: string) => async (decision: Decision) => {
  const base = `/api/v1/reviews/${reviewId}/suggestions/${decision.card.id}`;
  if (decision.state === "dismissed") await api.post(`${base}/dismiss`, {});
  else
    await api.post(`${base}/apply`, {
      surface: "word",
      with_comment: decision.withComment,
      ...(decision.observed ? { observed: decision.observed } : {}),
    });
};
