// Drives the real API against a running stack (node e2e/stack.mjs, with the relay as its
// model) and prints what each model-dependent feature did. A report, not assertions.
//   node e2e/sandbox.mjs <stack.json> playbook|threads|table
// stack.json holds the line stack.mjs printed: {url, workspace, email, password}.
import { readFileSync } from "node:fs";
import { buildDocx, markdownBlocks, patchDocx, readDocx } from "@legallabs/docx";

const [, , stackFile, scenario] = process.argv;
const stack = JSON.parse(readFileSync(stackFile, "utf8"));
let cookie = "";
const call = async (path, init = {}) =>
  fetch(`${stack.url}${path}`, {
    ...init,
    headers: {
      cookie,
      ...(typeof init.body === "string" ? { "content-type": "application/json" } : {}),
    },
  });
const json = async (path, init, status = 200) => {
  const res = await call(path, init);
  if (res.status !== status) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
};
const post = (path, body, status = 200) =>
  json(path, { method: "POST", body: JSON.stringify(body) }, status);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(read, done, what, ms = 3_600_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (done(v)) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(2000);
  }
}
const login = await fetch(`${stack.url}/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    workspace: stack.workspace,
    email: stack.email,
    password: stack.password,
  }),
});
cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

async function upload(vaultId, name, body, type) {
  const form = new FormData();
  form.set("file", new File([body], name, { type }));
  const { file } = await json(
    `/api/v1/vaults/${vaultId}/files`,
    { method: "POST", body: form },
    202,
  );
  return file;
}
async function vaultWith(name, files) {
  const { vault } = await post("/api/v1/vaults", { name }, 201);
  const ups = [];
  for (const f of files) ups.push(await upload(vault.id, f.name, f.body, f.type ?? "text/plain"));
  await until(
    () => json(`/api/v1/vaults/${vault.id}/tree`),
    (t) =>
      ups.every((u) => ["ready", "failed"].includes(t.files.find((f) => f.id === u.id)?.state)),
    "uploads",
  );
  return { vault, ups };
}

const MSA = `# Master Services Agreement

## 1. Services

The Supplier shall provide the hosted contract management services described in each order form.

## 2. Fees

Fees are payable within 15 days of the invoice date.

The Supplier may increase the fees at any time on seven days notice.

## 3. Liability

The Customer's liability under this agreement is unlimited.

## 4. Term

Either party may terminate this agreement for convenience on thirty days written notice. The Supplier may terminate on five days notice.

## 5. Confidentiality

Each party shall keep the other party's confidential information secret for the term and five years after.

## 6. Exclusivity

The Customer shall buy all office coffee beans from the roastery named in Schedule 4 for a decade.

## 7. Governing law

This agreement is governed by the laws of the State of Delaware.
`;

function supplierMsa() {
  const clean = buildDocx({
    blocks: markdownBlocks(MSA),
    author: "Pilot",
    date: "2026-11-16T00:00:00Z",
  });
  const services = readDocx(clean).paragraphs.find((p) => p.text.includes("hosted contract"));
  const patched = patchDocx(
    clean,
    [
      {
        id: "o1",
        kind: "insert_after",
        paragraph_index: services.index,
        before: "",
        after: "The Supplier may suspend the services at any time without notice.",
      },
    ],
    { author: "Other Side", date: "2026-11-16T00:00:00Z" },
  );
  return patched.bytes;
}
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const CONTRACTS = {
  "msa-england.txt": `MASTER SERVICES AGREEMENT

12. Liability
12.1 The Supplier's aggregate liability shall not exceed the fees paid in the twelve months before the claim.
12.2 The cap in clause 12.1 does not apply to fraud or wilful misconduct.

13. Termination
13.1 Either party may terminate this agreement on 90 days written notice.

14. Payment
14.1 The Customer shall pay each invoice within 30 days of receipt.

15. Governing law
15.1 This agreement is governed by the laws of England and Wales. The courts of England have exclusive jurisdiction.
`,
  "msa-new-york.txt": `MASTER SERVICES AGREEMENT

12. Liability
12.1 Neither party's liability shall exceed two times the annual fees. Liability for gross negligence is not limited.

13. Termination
13.1 Either party may terminate this agreement on 30 days written notice. Termination for cause is immediate.

14. Payment
14.1 Invoices are payable within 60 days.

15. Governing law
15.1 This agreement is governed by the laws of New York, without regard to conflict of laws principles.
`,
  "nda-singapore.txt": `MUTUAL NON-DISCLOSURE AGREEMENT

1. Confidential Information means all non-public information disclosed by either party.
2. The receiving party shall keep it confidential for five years and use it only to evaluate the proposed transaction.
3. This agreement is governed by the laws of Singapore.
4. Either party may terminate this agreement on 14 days written notice.
`,
};
const contractFiles = () => Object.entries(CONTRACTS).map(([name, body]) => ({ name, body }));

const scenarios = {
  async playbook() {
    const { ups } = await vaultWith("Playbook sandbox", [
      { name: "msa.docx", body: supplierMsa(), type: DOCX },
    ]);
    const created = await post(
      "/api/v1/playbooks",
      {
        name: "Sandbox MSA playbook",
        contract_type: "Master services agreement",
        source: { kind: "starter", template: "msa" },
      },
      201,
    );
    await post(`/api/v1/playbooks/${created.playbook.id}/publish`, {});
    const started = await post(
      `/api/v1/playbooks/${created.playbook.id}/reviews`,
      {
        document_version_id: ups[0].version_id,
        party: "Customer",
        paper: "theirs",
        mode: "standard",
        surface: "web",
      },
      201,
    );
    const { review } = await until(
      () => json(`/api/v1/reviews/${started.review_id}`),
      (r) => ["done", "failed", "cancelled"].includes(r.review.status),
      "review",
    );
    console.log(JSON.stringify(review, null, 1));
  },
  async threads() {
    const { vault } = await vaultWith("Threads sandbox", contractFiles());
    const questions = [
      "What is the Supplier's liability cap in the England contract?",
      "Which agreements are governed by New York law, and how long is the termination notice?",
      "Within how many days must invoices be paid under each MSA?",
      "What is the arbitration clause in these agreements?",
      "How long does confidentiality last in the NDA?",
    ];
    for (const content of questions) {
      const asked = await post(
        "/api/v1/threads",
        { content, scope: { document_ids: [], vault_ids: [vault.id], sources: [] } },
        202,
      );
      const text = await (await call(`/api/v1/runs/${asked.run_id}/events`)).text();
      const evs = text
        .split("\n\n")
        .filter((b) => b.includes("event:"))
        .map((b) => {
          const f = (n) =>
            b
              .split("\n")
              .find((l) => l.startsWith(`${n}:`))
              ?.slice(n.length + 1)
              .trim() ?? "";
          return { event: f("event"), data: JSON.parse(f("data") || "{}") };
        });
      const { thread } = await json(`/api/v1/threads/${asked.thread_id}`);
      const last = thread.messages.at(-1);
      console.log(
        JSON.stringify(
          {
            question: content,
            events: evs.map((e) => e.event),
            done: evs.at(-1)?.data,
            answer: last?.content,
            citations: last?.citations,
          },
          null,
          1,
        ),
      );
    }
  },
  async deep() {
    const { vault } = await vaultWith("Deep sandbox", contractFiles());
    const asked = await post(
      "/api/v1/threads",
      {
        content:
          "Compare the liability, payment and termination positions across all three agreements.",
        scope: { document_ids: [], vault_ids: [vault.id], sources: [] },
        deep_analysis: true,
      },
      202,
    );
    // The plan waits for approval; approve as soon as it is accepted.
    let approved = null;
    for (let i = 0; i < 120 && !approved?.ok; i++) {
      await sleep(2000);
      approved = await call(`/api/v1/runs/${asked.run_id}/approve`, { method: "POST" });
    }
    console.log("approve:", approved?.status);
    const text = await (await call(`/api/v1/runs/${asked.run_id}/events`)).text();
    const events = text
      .split("\n\n")
      .filter((b) => b.includes("event:"))
      .map((b) => b.replace(/\n/g, " | ").slice(0, 600));
    const { thread } = await json(`/api/v1/threads/${asked.thread_id}`);
    console.log(JSON.stringify({ events, messages: thread.messages }, null, 1));
  },
  async table() {
    const { vault, ups } = await vaultWith("Table sandbox", contractFiles());
    const { table } = await post(
      "/api/v1/review-tables",
      {
        name: "Sandbox table",
        source: { kind: "vault", vault_id: vault.id, document_ids: ups.map((u) => u.id) },
      },
      201,
    );
    const base = `/api/v1/review-tables/${table.id}`;
    const columns = [
      {
        label: "Governing law",
        type: "classify",
        prompt: "Which law governs this agreement?",
        options: {
          options: [
            { id: "england", label: "England and Wales", color: "blue" },
            { id: "new_york", label: "New York", color: "green" },
            { id: "singapore", label: "Singapore", color: "red" },
          ],
          allow_other: false,
        },
      },
      {
        label: "Termination notice",
        type: "number",
        prompt: "How many days of written notice are needed to terminate?",
      },
      {
        label: "Liability cap",
        type: "free",
        prompt: "Summarise the liability cap in one sentence.",
      },
    ];
    const ids = [];
    for (const column of columns) {
      const res = await call(`${base}/columns`, { method: "POST", body: JSON.stringify(column) });
      if (!res.ok) throw new Error(`column: ${res.status} ${await res.text()}`);
      ids.push((await res.json()).column.id);
    }
    for (const id of ids) {
      const res = await call(`${base}/columns/${id}/run`, {
        method: "POST",
        body: JSON.stringify({ scope: "all" }),
      });
      if (!res.ok) throw new Error(`run: ${res.status} ${await res.text()}`);
      await res.body?.cancel();
    }
    await until(
      () => json(base),
      (t) =>
        ids.every((id) => ["done", "failed"].includes(t.columns.find((c) => c.id === id)?.state)),
      "columns",
    );
    const page = await json(`${base}/rows?limit=200`);
    console.log(
      JSON.stringify(
        { columns: columns.map((c, i) => [ids[i], c.label]), rows: page.rows, cells: page.cells },
        null,
        1,
      ),
    );
  },
};

if (!scenarios[scenario]) {
  console.error("usage: node e2e/sandbox.mjs <stack.json> playbook|threads|table");
  process.exit(2);
}
await scenarios[scenario]();
