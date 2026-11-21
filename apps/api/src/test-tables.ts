import { randomUUID } from "node:crypto";
import { createGateway, type Message } from "@legallabs/model-gateway";
import { createMemoryStore } from "@legallabs/storage";
import { expect } from "vitest";
import { createApp } from "./app.js";
import { createAuth } from "./auth/auth.js";
import { hashPassword } from "./auth/password.js";
import { createDrafts } from "./drafts/drafts.js";
import type { Notifier } from "./notifications/notify.js";
import { createRunLog } from "./runs/log.js";
import { createReviewTables } from "./tables/module.js";
import {
  PASSWORD,
  type Seeded,
  seedMember,
  testDocuments,
  testPool,
  testThreads,
} from "./test-db.js";
import { createVaults } from "./vaults/vaults.js";

// Shared by the review-table API tests: a real app over the test database, a scripted model
// standing in for the provider, and vaults whose files are read as they are uploaded.
export const pool = testPool();

export const CREDIT =
  "This Credit Agreement is dated 1 March 2024 between the Borrower and the Lenders. The aggregate commitments are USD 1.5 million. This Agreement is governed by the laws of the State of New York.";
export const LEASE =
  "This Lease is dated 5 June 2023 between the Landlord and the Tenant. The annual rent is GBP 250,000 payable quarterly. This Lease is governed by the laws of England and Wales.";

const sentences = (text: string) => text.split(/(?<=\.)\s+/);

/**
 * Stands in for the model: answers from the passages it was shown, quoting the sentence that
 * holds the answer, the way a good model would. "Termination fee" is never in the documents.
 */
// What the Column Builder model proposes: 35 columns, one of them invalid, so the cap and the
// schema check both have something to do.
const PROPOSALS = JSON.stringify({
  columns: [
    { label: "Effective date", type: "date", prompt: "When is it dated?", options: {} },
    { label: "Commitments", type: "currency", prompt: "What are the commitments?", options: {} },
    {
      label: "Governing law",
      type: "classify",
      prompt: "Which law governs?",
      options: {
        options: [
          { id: "ny", label: "New York", color: "blue" },
          { id: "ew", label: "England and Wales", color: "purple" },
        ],
      },
    },
    { label: "Broken", type: "classify", prompt: "No options", options: { options: [] } },
    ...Array.from({ length: 31 }, (_, i) => ({
      label: `Term ${i + 1}`,
      type: "free",
      prompt: `What is term ${i + 1}?`,
      options: {},
    })),
  ],
});

export function fakeModel(messages: readonly Message[]): string {
  if (messages[0]?.content.startsWith("You design review tables")) return PROPOSALS;
  const user = messages.find((m) => m.role === "user")?.content ?? "";
  const label = /Column: (.+)/.exec(user)?.[1] ?? "";
  const passages = [
    ...user.matchAll(/<passage-\w+ doc="(D\d+)" page="(\d+)">\n([\s\S]*?)\n<\/passage/g),
  ];
  const find = (pattern: RegExp) => {
    for (const [, doc, page, text] of passages) {
      for (const sentence of sentences(text ?? "")) {
        const match = pattern.exec(sentence);
        if (match) return { doc, page: Number(page), quote: sentence, value: match[1] ?? sentence };
      }
    }
    return null;
  };
  const hit =
    label === "Date"
      ? find(/dated (\d+ \w+ \d{4})/)
      : label === "Amount"
        ? find(/(?:commitments|rent) (?:are|is) ([A-Z]{3} [\d.,]+(?: million)?)/)
        : label === "Governing law"
          ? find(/laws of (?:the State of )?(New York|England and Wales)/)
          : null;
  if (!hit)
    return JSON.stringify({
      value: null,
      reasoning: "Not stated.",
      citations: [],
      not_found: true,
    });
  return JSON.stringify({
    value: hit.value,
    reasoning: "Stated in the document.",
    citations: [{ doc: hit.doc, page: hit.page, quote: hit.quote }],
    not_found: false,
  });
}

export interface HarnessOptions {
  asks?: number;
  hold?: Promise<void>;
  vaultLimit?: number;
  /** Answer through a priced route instead of the free local one, so costs add up. */
  paid?: boolean;
  /** Answers instead of fakeModel, to script what the provider says. */
  model?: (messages: readonly Message[]) => string;
  /** Receives what a sync pass reports to an owner who opted in. */
  notifier?: Notifier;
}

export function harness(options: HarnessOptions = {}) {
  const store = createMemoryStore();
  const documents = testDocuments(pool, { store });
  const model = {
    complete: async ({ messages }: { messages: readonly Message[] }) => {
      await options.hold;
      return {
        text: (options.model ?? fakeModel)(messages),
        usage: { input_tokens: 500, output_tokens: 40 },
      };
    },
  };
  const gateway = createGateway({
    providers: options.paid ? { anthropic: model } : { ollama: model },
    contextWindows: { ollama: 8_192 },
    recordUsage: async () => {},
  });
  const log = createRunLog(pool);
  const tables = createReviewTables(pool, {
    gateway,
    documents,
    log,
    dependencyPollMs: 20,
    ...(options.notifier ? { notifier: options.notifier } : {}),
    ...(options.vaultLimit ? { vaultDocumentLimit: options.vaultLimit } : {}),
  });
  const app = createApp({
    auth: createAuth(pool),
    documents,
    threads: {
      ...testThreads(pool, documents),
      log,
      ...(options.asks ? { asksPerWindow: options.asks } : {}),
    },
    drafts: createDrafts(pool, { gateway }),
    vaults: createVaults(pool, { documents, store }),
    tables,
    clientIp: () => "203.0.113.9",
  });
  const signIn = async (m: Pick<Seeded, "slug" | "email">) => {
    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: m.slug, email: m.email, password: PASSWORD }),
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  };
  const raw = (cookie: string, method: string, path: string, json?: unknown) =>
    app.request(`/api/v1${path}`, {
      method,
      headers: { cookie, ...(json === undefined ? {} : { "content-type": "application/json" }) },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    });
  // biome-ignore lint/suspicious/noExplicitAny: test responses are read loosely
  const call = async (
    cookie: string,
    method: string,
    path: string,
    json?: unknown,
  ): Promise<{ status: number; body: any }> => {
    const res = await raw(cookie, method, path, json);
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const vault = async (cookie: string, files: Record<string, string>) => {
    const created = await call(cookie, "POST", "/vaults", {
      name: `Deal ${randomUUID().slice(0, 4)}`,
    });
    const id = created.body.vault.id as string;
    const ids: string[] = [];
    for (const [name, content] of Object.entries(files)) {
      const form = new FormData();
      form.set("file", new File([content], name));
      const res = await app.request(`/api/v1/vaults/${id}/files`, {
        method: "POST",
        headers: { cookie },
        body: form,
      });
      ids.push(((await res.json()) as { file: { id: string } }).file.id);
    }
    return { id, ids };
  };
  return { app, call, raw, signIn, vault, tables, log };
}

export async function colleague(m: Seeded, permissions = "{threads.use,tables.create}") {
  const email = `ben-${randomUUID().slice(0, 6)}@${m.slug}.test`;
  const role = await pool.query<{ id: string }>(
    "insert into core.role (workspace_id, name, permissions) values ($1, $2, $3) returning id",
    [m.workspaceId, `User ${email}`, permissions],
  );
  const user = await pool.query<{ id: string }>(
    `insert into core."user" (workspace_id, email, role_id, status) values ($1, $2, $3, 'active') returning id`,
    [m.workspaceId, email, role.rows[0]?.id],
  );
  const userId = user.rows[0]?.id ?? "";
  await pool.query(
    "insert into core.password_credential (workspace_id, user_id, password_hash) values ($1, $2, $3)",
    [m.workspaceId, userId, await hashPassword(PASSWORD)],
  );
  return { slug: m.slug, email, userId, workspaceId: m.workspaceId };
}

export const DATE = { label: "Date", type: "date", prompt: "When is the agreement dated?" };
export const AMOUNT = {
  label: "Amount",
  type: "currency",
  prompt: "What is the main amount?",
  options: { decimals: 2 },
};
export const LAW = {
  label: "Governing law",
  type: "classify",
  prompt: "Which law governs?",
  options: {
    options: [
      { id: "ny", label: "New York", color: "blue" },
      { id: "ew", label: "England and Wales", color: "purple" },
    ],
    allow_other: false,
  },
};
export const FEE = {
  label: "Termination fee",
  type: "currency",
  prompt: "What is the termination fee?",
};

export async function setup(options: HarnessOptions = {}) {
  const h = harness(options);
  const m = await seedMember(pool);
  const cookie = await h.signIn(m);
  const v = await h.vault(cookie, { "credit.txt": CREDIT, "lease.txt": LEASE });
  const created = await h.call(cookie, "POST", "/review-tables", {
    name: "Deal review",
    source: { kind: "vault", vault_id: v.id, document_ids: v.ids },
  });
  expect(created.status).toBe(201);
  return { h, m, cookie, v, tableId: created.body.table.id as string };
}

export const addColumn = async (s: Awaited<ReturnType<typeof setup>>, body: object) => {
  const res = await s.h.call(s.cookie, "POST", `/review-tables/${s.tableId}/columns`, body);
  expect(res.status).toBe(201);
  return res.body.column.id as string;
};

export const runAndWait = async (
  s: Awaited<ReturnType<typeof setup>>,
  columnId: string,
  scope: unknown = "all",
) => {
  const res = await s.h.call(
    s.cookie,
    "POST",
    `/review-tables/${s.tableId}/columns/${columnId}/run`,
    { scope },
  );
  expect(res.status).toBe(202);
  await s.h.tables.runner.idle();
  return res.body;
};

export const rows = async (s: Awaited<ReturnType<typeof setup>>, query = "") =>
  (await s.h.call(s.cookie, "GET", `/review-tables/${s.tableId}/rows?limit=200${query}`)).body;
