import type { Finding, Playbook, Review } from "@legallabs/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewReview } from "./NewReview.js";
import { ReviewPage } from "./ReviewPage.js";
import { parseReviewRoute, reviewHash } from "./route.js";

// jsdom lacks what Radix's select and the scroll-to calls use.
window.HTMLElement.prototype.scrollIntoView ??= () => {};
window.HTMLElement.prototype.hasPointerCapture ??= () => false;
window.HTMLElement.prototype.releasePointerCapture ??= () => {};

// Invented ids and clause text.
const id = (n: number) => `0190c000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const PLAYBOOK = id(1);
const DOC = id(2);
const VERSION = id(3);
const REVIEW = id(4);
const RUN = id(5);
const RULE = id(6);
const SID = id(7);
const HASH = "b".repeat(64);
const TEXT = "The Supplier's liability is unlimited.";

const playbook: Playbook = {
  id: PLAYBOOK,
  workspace_id: id(8),
  owner_id: id(9),
  name: "Customer MSA",
  contract_type: "MSA",
  guidance: null,
  status: "published",
  version_id: id(10),
  version_no: 1,
  rules: [
    {
      id: RULE,
      ordinal: 0,
      title: "Limitation of liability",
      standard_position: "Capped at 12 months' fees.",
      fallbacks: [],
      flag: false,
      actions: [],
      provenance: null,
    },
  ],
  access: "view",
  created_at: "2026-11-01T00:00:00.000Z",
  updated_at: "2026-11-01T00:00:00.000Z",
};

const finding: Finding = {
  rule_id: RULE,
  rule_title: "Limitation of liability",
  status: "not_acceptable",
  flag: false,
  evidence: [
    { paragraph_index: 0, char_from: 0, char_to: TEXT.length - 1, quote: TEXT, verified: "ok" },
  ],
  explanation: "Unlimited liability is unacceptable.",
  suggestion: {
    id: SID,
    rule_id: RULE,
    anchor: { paragraph_index: 0, char_from: 28, char_to: 37, para_hash: HASH },
    kind: "replace",
    before: "unlimited",
    after: "capped at the fees paid in the prior 12 months",
    justification: "The playbook caps liability at 12 months' fees.",
    status: "pending",
  },
  verification: "ok",
  model: "test/model",
  usage: { input_tokens: 1, output_tokens: 1 },
  cost_usd: 0,
};

const review = (overrides: Partial<Review> = {}): Review => ({
  id: REVIEW,
  run_id: RUN,
  playbook_id: PLAYBOOK,
  playbook_version_id: id(10),
  playbook_name: "Customer MSA",
  document_id: DOC,
  document_version_id: VERSION,
  document_name: "Supplier MSA.docx",
  customisation: { party: "Acme", paper: "theirs", mode: "standard", scope: "all" },
  surface: "web",
  status: "done",
  clause_map_size: 1,
  excluded_regions: {},
  results: [finding],
  gaps: [],
  summary: { acceptable: 0, needs_review: 0, not_acceptable: 1, not_found: 0, gaps: 0 },
  warnings: [],
  usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0, models: [] },
  started_at: "2026-11-15T00:00:00.000Z",
  finished_at: "2026-11-15T00:01:00.000Z",
  ...overrides,
});

type Handler = (body: unknown, url: string) => [number, unknown];

function serve(routes: Record<string, Handler>) {
  const sent: { route: string; url: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = input.split("?")[0] ?? input;
      const route = `${init?.method ?? "GET"} ${path}`;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
      sent.push({ route, url: input, body });
      const [status, json] = routes[route]?.(body, input) ?? [
        404,
        { code: "NOT_FOUND", message: "No." },
      ];
      if (typeof json === "object" && json !== null && "file" in json) {
        return new Response(String(json.file), {
          status,
          headers: { "content-disposition": 'attachment; filename="Supplier MSA redline.docx"' },
        });
      }
      return new Response(status === 202 ? null : JSON.stringify(json), { status });
    }),
  );
  return sent;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.location.hash = "";
});

describe("review routes", () => {
  it("round-trip through the address", () => {
    for (const route of [
      { page: "new", playbookId: null, documentId: null } as const,
      { page: "new", playbookId: PLAYBOOK, documentId: DOC } as const,
      { page: "review", reviewId: REVIEW } as const,
    ]) {
      expect(parseReviewRoute(reviewHash(route))).toEqual(route);
    }
    expect(parseReviewRoute("#/playbooks")).toBeNull();
  });
});

describe("NewReview", () => {
  it("starts a review of a vault file against a chosen playbook", async () => {
    const sent = serve({
      "GET /api/v1/playbooks": () => [200, { playbooks: [{ ...playbook, rule_count: 1 }] }],
      [`GET /api/v1/playbooks/${PLAYBOOK}`]: () => [200, { playbook }],
      [`GET /api/v1/documents/${DOC}`]: () => [
        200,
        {
          document: {
            id: DOC,
            version_id: VERSION,
            name: "Supplier MSA.docx",
            status: "indexed",
            page_count: 140,
          },
        },
      ],
      [`POST /api/v1/playbooks/${PLAYBOOK}/reviews`]: () => [
        201,
        { review_id: REVIEW, run_id: RUN },
      ],
    });
    render(<NewReview playbookId={null} documentId={DOC} onCancel={vi.fn()} />);
    expect(await screen.findByText(/Reviews over 100 pages/)).toBeTruthy();
    // The playbook picker is a Radix select; choose through its trigger.
    fireEvent.click(await screen.findByRole("combobox", { name: "Playbook" }));
    fireEvent.click(await screen.findByRole("option", { name: "Customer MSA" }));
    fireEvent.change(screen.getByLabelText("Representing"), { target: { value: "Acme" } });
    const run = screen.getByRole("button", { name: "Run review" }) as HTMLButtonElement;
    await waitFor(() => expect(run.disabled).toBe(false));
    fireEvent.click(run);
    await waitFor(() => expect(window.location.hash).toBe(`#/reviews/${REVIEW}`));
    expect(sent.find((s) => s.route.startsWith("POST"))?.body).toEqual({
      party: "Acme",
      paper: "theirs",
      mode: "standard",
      scope: "all",
      document_version_id: VERSION,
      surface: "web",
    });
  });

  it("shows why a review could not start", async () => {
    serve({
      [`GET /api/v1/playbooks/${PLAYBOOK}`]: () => [200, { playbook }],
      "GET /api/v1/documents": () => [
        200,
        { documents: [{ id: DOC, version_id: VERSION, name: "Big.docx", status: "indexed" }] },
      ],
      [`POST /api/v1/playbooks/${PLAYBOOK}/reviews`]: () => [
        422,
        { code: "DOC_TOO_LARGE", message: "That document is over 1,000,000 characters." },
      ],
    });
    render(<NewReview playbookId={PLAYBOOK} documentId={null} onCancel={vi.fn()} />);
    fireEvent.click(await screen.findByRole("combobox", { name: "Contract" }));
    fireEvent.click(await screen.findByRole("option", { name: "Big.docx" }));
    const run = screen.getByRole("button", { name: "Run review" }) as HTMLButtonElement;
    await waitFor(() => expect(run.disabled).toBe(false));
    fireEvent.click(run);
    expect((await screen.findByRole("alert")).textContent).toMatch(/over 1,000,000/);
  });
});

describe("ReviewPage", () => {
  const editor = (current: () => Review) =>
    serve({
      [`GET /api/v1/reviews/${REVIEW}`]: () => [200, { review: current() }],
      [`GET /api/v1/playbooks/${PLAYBOOK}`]: () => [200, { playbook }],
      [`GET /api/v1/reviews/${REVIEW}/document`]: () => [
        200,
        { kind: "docx", paragraphs: [{ index: 0, text: TEXT, excluded: false }] },
      ],
      [`POST /api/v1/reviews/${REVIEW}/suggestions/${SID}/apply`]: () => [
        200,
        {
          suggestion_id: SID,
          status: "applied",
          anchor: finding.suggestion?.anchor,
          replace_mode: "paragraph",
        },
      ],
      [`POST /api/v1/reviews/${REVIEW}/suggestions/${SID}/dismiss`]: () => [
        200,
        { suggestion: { ...finding.suggestion, status: "dismissed" } },
      ],
      [`POST /api/v1/reviews/${REVIEW}/redline`]: () => [200, { file: "docx bytes" }],
    });

  it("shows the contract beside its cards and records decisions", async () => {
    const sent = editor(() => review());
    render(<ReviewPage reviewId={REVIEW} />);
    expect(await screen.findByRole("document", { name: "Contract" })).toBeTruthy();
    const rail = screen.getByRole("region", { name: "Review results" });
    fireEvent.click(within(rail).getByRole("button", { name: "Apply with comment" }));
    await waitFor(() =>
      expect(sent.find((s) => s.route.endsWith("/apply"))?.body).toEqual({
        surface: "web",
        with_comment: true,
      }),
    );
    fireEvent.click(within(rail).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(sent.some((s) => s.route.endsWith("/dismiss"))).toBe(true));
  });

  it("downloads the redline with undecided suggestions by default", async () => {
    const sent = editor(() => review());
    const created = vi.fn(() => "blob:redline");
    vi.stubGlobal(
      "URL",
      Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() }),
    );
    render(<ReviewPage reviewId={REVIEW} />);
    fireEvent.click(await screen.findByRole("button", { name: "Download redline" }));
    await waitFor(() => expect(created).toHaveBeenCalledOnce());
    expect(sent.find((s) => s.route.endsWith("/redline"))?.body).toEqual({
      include_pending: true,
    });
  });

  it("follows a running review, then opens the results", async () => {
    let current = review({ status: "running", results: [], finished_at: null });
    editor(() => current);
    vi.stubGlobal("EventSource", undefined);
    render(<ReviewPage reviewId={REVIEW} />);
    expect(await screen.findByRole("region", { name: "Review progress" })).toBeTruthy();
    current = review();
    // No EventSource here, so the page polls every two seconds.
    expect(
      await screen.findByRole("document", { name: "Contract" }, { timeout: 4000 }),
    ).toBeTruthy();
  });
});
