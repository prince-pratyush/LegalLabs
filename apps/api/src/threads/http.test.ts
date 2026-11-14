import type { ModelProvider } from "@legallabs/model-gateway";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createAuth } from "../auth/auth.js";
import {
  PASSWORD,
  type Seeded,
  seedMember,
  testDocuments,
  testPool,
  testThreads,
} from "../test-db.js";

const pool = testPool();
afterAll(() => pool.end());

const CLAUSE = "The supplier accepts liability for direct loss up to the fees paid.";
const answering = (text: string): ModelProvider => ({
  complete: async () => ({ text, usage: { input_tokens: 900, output_tokens: 40 } }),
});

function harness(asksPerWindow?: number) {
  const documents = testDocuments(pool);
  const deps = testThreads(pool, documents, {
    anthropic: answering(
      'Liable.<c doc="D1" page="1" quote="accepts liability"/> This uncited claim stands alone.',
    ),
  });
  const app = createApp({
    auth: createAuth(pool),
    documents,
    threads: { ...deps, ...(asksPerWindow ? { asksPerWindow } : {}) },
    clientIp: () => "203.0.113.9",
  });
  const signIn = async (m: Seeded) => {
    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: m.slug, email: m.email, password: PASSWORD }),
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  };
  const upload = async (cookie: string) => {
    const form = new FormData();
    form.set("file", new File([CLAUSE], "msa.txt", { type: "text/plain" }));
    const res = await app.request("/api/v1/documents", {
      method: "POST",
      headers: { cookie },
      body: form,
    });
    return ((await res.json()) as { document: { id: string } }).document.id;
  };
  const call = (cookie: string, path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) },
    });
  return { app, deps, signIn, upload, call };
}

const events = (text: string) =>
  text
    .split("\n\n")
    .filter((block) => block.includes("event:"))
    .map((block) => {
      const field = (name: string) =>
        block
          .split("\n")
          .find((line) => line.startsWith(`${name}:`))
          ?.slice(name.length + 1)
          .trim();
      return {
        id: Number(field("id")),
        event: field("event"),
        data: JSON.parse(field("data") ?? "{}"),
      };
    });

describe("thread API", () => {
  it("accepts a question, streams its run, and returns the verified answer", async () => {
    const { deps, signIn, upload, call } = harness();
    const m = await seedMember(pool);
    const cookie = await signIn(m);
    const documentId = await upload(cookie);

    const res = await call(cookie, "/api/v1/threads", {
      method: "POST",
      body: JSON.stringify({ content: "Who is liable?", scope: { document_ids: [documentId] } }),
    });
    expect(res.status).toBe(202);
    const started = (await res.json()) as { thread_id: string; message_id: string; run_id: string };
    await deps.threads.settled();

    const stream = await call(cookie, `/api/v1/runs/${started.run_id}/events`);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const all = events(await stream.text());
    expect(all[0]).toMatchObject({ id: 1, event: "status", data: { status: "running" } });
    expect(all.at(-1)?.event).toBe("done");
    expect(all.find((e) => e.event === "citation")?.data.citation.verified).toBe("ok");

    // A reconnect after event 3 gets only what came after it.
    const resumed = events(
      await (
        await call(cookie, `/api/v1/runs/${started.run_id}/events`, {
          headers: { "last-event-id": "3" },
        })
      ).text(),
    );
    expect(resumed.map((e) => e.id)).toEqual(all.slice(3).map((e) => e.id));

    const run = (await (await call(cookie, `/api/v1/runs/${started.run_id}`)).json()) as {
      run: { status: string; message_id: string; coverage: { mode: string } };
    };
    expect(run.run).toMatchObject({ status: "done", coverage: { mode: "full_read" } });

    const thread = (await (await call(cookie, `/api/v1/threads/${started.thread_id}`)).json()) as {
      thread: { read_only: boolean; messages: Record<string, unknown>[] };
    };
    const answer = thread.thread.messages.at(-1);
    expect(thread.thread.read_only).toBe(false);
    expect(answer).toMatchObject({
      id: run.run.message_id,
      model: "anthropic/claude-haiku-5-5",
      input_tokens: 900,
      output_tokens: 40,
      cost_usd: expect.any(Number),
      ungrounded: [[8, 40]],
    });
    expect((answer?.citations as Record<string, unknown>[] | undefined)?.[0]).toMatchObject({
      status: "ok",
      document_name: "msa.txt",
      open_url: expect.stringMatching(new RegExp(`^/d/${documentId}/v/1\\?p=1&cf=\\d+&ct=\\d+$`)),
    });
  });

  it("lists history, refuses bad input, and limits how often one person asks", async () => {
    const { deps, signIn, upload, call } = harness(1);
    const m = await seedMember(pool);
    const cookie = await signIn(m);
    const documentId = await upload(cookie);
    const body = JSON.stringify({ content: "Q?", scope: { document_ids: [documentId] } });

    expect((await call(cookie, "/api/v1/threads", { method: "POST", body: "{}" })).status).toBe(
      400,
    );
    expect((await call(cookie, "/api/v1/threads", { method: "POST", body })).status).toBe(202);
    expect((await call(cookie, "/api/v1/threads", { method: "POST", body })).status).toBe(429);
    await deps.threads.settled();

    const history = (await (await call(cookie, "/api/v1/history?docs=1")).json()) as {
      items: { title: string; status: string }[];
    };
    expect(history.items).toEqual([expect.objectContaining({ title: "Q?", status: "done" })]);
    expect((await call(cookie, "/api/v1/history?docs=lots")).status).toBe(400);

    const options = (await (await call(cookie, "/api/v1/scope-options")).json()) as {
      models: { id: string }[];
      vaults: unknown[];
    };
    expect(options.models.map((x) => x.id)).toEqual(["anthropic/claude-haiku-5-5"]);
    expect(options.vaults).toEqual([]);
  });

  it("hides another person's run and its events", async () => {
    const { deps, signIn, upload, call } = harness();
    const owner = await seedMember(pool);
    const other = await seedMember(pool);
    const ownerCookie = await signIn(owner);
    const documentId = await upload(ownerCookie);
    const started = (await (
      await call(ownerCookie, "/api/v1/threads", {
        method: "POST",
        body: JSON.stringify({ content: "Q?", scope: { document_ids: [documentId] } }),
      })
    ).json()) as { run_id: string };
    await deps.threads.settled();

    const otherCookie = await signIn(other);
    expect((await call(otherCookie, `/api/v1/runs/${started.run_id}`)).status).toBe(404);
    expect((await call(otherCookie, `/api/v1/runs/${started.run_id}/events`)).status).toBe(404);
  });
});
