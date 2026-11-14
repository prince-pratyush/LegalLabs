import { parseCitationPath } from "@legallabs/contracts";
import { strFromU8, unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error: a plain script, shared with `node e2e/stack.mjs`.
import { startStack } from "./stack.mjs";

interface Stack {
  url: string;
  workspace: string;
  email: string;
  password: string;
  stop: () => void;
}

const CONTRACT = `MASTER SERVICES AGREEMENT

12. Liability
12.1 The Supplier's aggregate liability shall not exceed the fees paid in the twelve months before the claim.
12.2 The cap in clause 12.1 does not apply to fraud or wilful misconduct.

13. Termination
13.1 Either party may terminate this agreement on ninety days written notice.
`;

let stack: Stack;
let cookie = "";

const call = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`${stack.url}${path}`, {
    ...init,
    headers: {
      cookie,
      ...(typeof init.body === "string" ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  return res;
};
const json = async <T>(path: string, init: RequestInit = {}, status = 200): Promise<T> => {
  const res = await call(path, init);
  if (res.status !== status) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
};
const post = <T>(path: string, body: unknown, status = 200) =>
  json<T>(path, { method: "POST", body: JSON.stringify(body) }, status);

type Event = { event: string; id: number; data: Record<string, unknown> };

// Reads the run's event stream to its end, as the browser does.
async function events(runId: string): Promise<Event[]> {
  const res = await call(`/api/v1/runs/${runId}/events`);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((block) => block.includes("event:"))
    .map((block) => {
      const field = (name: string) =>
        block
          .split("\n")
          .find((line) => line.startsWith(`${name}:`))
          ?.slice(name.length + 1)
          .trim() ?? "";
      return {
        event: field("event"),
        id: Number(field("id")),
        data: JSON.parse(field("data") || "{}"),
      };
    });
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string) {
  const deadline = Date.now() + 15 * 60_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

beforeAll(async () => {
  stack = await startStack();
  const res = await fetch(`${stack.url}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspace: stack.workspace,
      email: stack.email,
      password: stack.password,
    }),
  });
  expect(res.status).toBe(200);
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}, 180_000);

afterAll(() => stack?.stop());

describe("pilot acceptance 1", () => {
  it(
    "upload → vault → ask → verified citation → viewer → draft → Word export",
    async () => {
      // 1. A vault, and a contract uploaded into it.
      const { vault } = await post<{ vault: { id: string } }>(
        "/api/v1/vaults",
        { name: "Pilot deal room" },
        201,
      );
      const form = new FormData();
      form.set("file", new File([CONTRACT], "msa.txt", { type: "text/plain" }));
      const uploaded = await json<{ file: { id: string } }>(
        `/api/v1/vaults/${vault.id}/files`,
        { method: "POST", body: form },
        202,
      );
      const file = await until(
        async () =>
          (
            await json<{ files: { id: string; state: string }[] }>(
              `/api/v1/vaults/${vault.id}/tree`,
            )
          ).files.find((f) => f.id === uploaded.file.id),
        (f) => f?.state === "ready" || f?.state === "failed",
        "the upload to be read",
      );
      expect(file?.state).toBe("ready");

      // 2. Ask over the vault; the answer streams and every citation is checked first.
      const options = await json<{ vaults: { id: string }[] }>("/api/v1/scope-options");
      expect(options.vaults.map((v) => v.id)).toContain(vault.id);
      const asked = await post<{ thread_id: string; run_id: string }>(
        "/api/v1/threads",
        {
          content: "What is the Supplier's liability cap?",
          scope: { document_ids: [], vault_ids: [vault.id], sources: [] },
        },
        202,
      );
      const stream = await events(asked.run_id);
      expect(stream.at(-1)?.event).toBe("done");
      expect(stream.map((e) => e.id)).toEqual(stream.map((_, i) => i + 1));
      const citation = stream.find((e) => e.event === "citation")?.data.citation as {
        verified: string;
        open_url?: string;
        quote: string;
      };
      expect(citation.verified).toBe("ok");
      const done = stream.at(-1)?.data as {
        citations: { ok: number; total: number };
        model: string;
      };
      expect(done.citations.ok).toBe(done.citations.total);

      // 3. The citation opens the viewer at the exact span on the cited page.
      const target = parseCitationPath(citation.open_url ?? "");
      expect(target).toMatchObject({ document_id: uploaded.file.id, version_no: 1, page: 1 });
      expect(CONTRACT.slice(target?.char_from, target?.char_to)).toBe(citation.quote);
      const { thread } = await json<{
        thread: {
          messages: {
            id: string;
            role: string;
            citations: { status: string; open_url: string | null }[];
          }[];
        };
      }>(`/api/v1/threads/${asked.thread_id}`);
      const answer = thread.messages.at(-1);
      expect(answer?.citations[0]).toMatchObject({ status: "ok", open_url: citation.open_url });

      // 4. Draft from the answer, let the assistant edit it, and export the edit as tracked changes.
      const created = await post<{ draft: { id: string; latest: { body: string } } }>(
        `/api/v1/threads/${asked.thread_id}/drafts`,
        { kind: "editor", from_message_id: answer?.id },
        201,
      );
      expect(created.draft.latest.body).toContain("[1]");
      const edited = await post<{ draft: { latest: { no: number } } }>(
        `/api/v1/drafts/${created.draft.id}/edit`,
        { instruction: "Add a closing line saying the draft was reviewed." },
        201,
      );
      expect(edited.draft.latest.no).toBe(2);
      const diff = await json<{ summary: { insertions: number } }>(
        `/api/v1/drafts/${created.draft.id}/diff?from=1&to=2`,
      );
      expect(diff.summary.insertions).toBeGreaterThan(0);
      const exported = await call(`/api/v1/drafts/${created.draft.id}/export?tracked_from=1`);
      expect(exported.status).toBe(200);
      expect(exported.headers.get("content-type")).toContain("wordprocessingml");
      const parts = unzipSync(new Uint8Array(await exported.arrayBuffer()));
      const xml = strFromU8(parts["word/document.xml"] ?? new Uint8Array());
      expect(xml).toContain("<w:ins ");
      expect(Object.keys(parts)).toEqual(
        expect.arrayContaining(["[Content_Types].xml", "word/styles.xml"]),
      );

      // 5. The work shows up in History.
      const history = await json<{ items: { id: string; status: string }[] }>("/api/v1/history");
      expect(history.items[0]).toMatchObject({ id: asked.thread_id, status: "done" });
    },
    30 * 60_000,
  );
});
