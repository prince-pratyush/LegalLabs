import { type Api, safeUrl } from "@legallabs/addin";
import { describe, expect, it } from "vitest";
import { ask } from "./ask.js";

function fakeApi() {
  const calls: string[] = [];
  let docPolls = 0;
  const api: Api = {
    upload: async <T>(path: string) => {
      calls.push(`upload ${path}`);
      return { document: { id: "doc1", status: "queued", failure_reason: null } } as T;
    },
    get: async <T>(path: string) => {
      calls.push(`get ${path}`);
      if (path.startsWith("/api/v1/documents/")) {
        docPolls++;
        return {
          document: {
            id: "doc1",
            status: docPolls > 1 ? "indexed" : "parsing",
            failure_reason: null,
          },
        } as T;
      }
      if (path.startsWith("/api/v1/runs/")) return { run: { status: "done" } } as T;
      return {
        thread: {
          messages: [
            { role: "user", content: "q", ungrounded: [], citations: [] },
            {
              role: "assistant",
              content: "Ten years.",
              ungrounded: [],
              citations: [
                {
                  n: 1,
                  at: 10,
                  document_id: "doc1",
                  document_name: "NDA (selection).txt",
                  page: 1,
                  quote: "ten (10) years",
                  status: "ok",
                  open_url: "/documents/doc1?page=1",
                },
              ],
            },
          ],
        },
      } as T;
    },
    post: async <T>(path: string, body?: unknown) => {
      calls.push(`post ${path} ${JSON.stringify(body)}`);
      return { thread_id: "t1", run_id: "r1" } as T;
    },
  };
  return { api, calls };
}

const noWait = async () => {};

describe("ask", () => {
  it("uploads the scoped text, waits for it to be read, asks within it, and maps citations", async () => {
    const { api, calls } = fakeApi();
    const steps: string[] = [];
    const answer = await ask(
      api,
      {
        question: "How long?",
        text: "The term is ten (10) years.",
        scope: "selection",
        title: "NDA",
        previous: null,
      },
      (s) => steps.push(s),
      noWait,
    );
    expect(steps).toEqual(["uploading", "reading", "answering"]);
    expect(calls).toContain(
      `post /api/v1/threads ${JSON.stringify({ content: "How long?", scope: { document_ids: ["doc1"], vault_ids: [], sources: [] } })}`,
    );
    expect(answer.citations[0]).toMatchObject({
      n: 1,
      documentId: "doc1",
      quote: "ten (10) years",
      openUrl: "/documents/doc1?page=1",
    });
  });

  it("asks a follow-up in the same thread without re-uploading the same text", async () => {
    const { api, calls } = fakeApi();
    const input = {
      question: "How long?",
      text: "Same text",
      scope: "document" as const,
      title: "NDA",
    };
    const first = await ask(api, { ...input, previous: null }, () => {}, noWait);
    calls.length = 0;
    await ask(api, { ...input, question: "And then?", previous: first.context }, () => {}, noWait);
    expect(calls.some((c) => c.startsWith("upload"))).toBe(false);
    expect(calls.some((c) => c.startsWith("post /api/v1/threads/t1/messages"))).toBe(true);
  });
});

describe("safeUrl", () => {
  it("opens LegalLabs paths and https links only", () => {
    const origin = "https://legal.test";
    expect(safeUrl("/documents/1?page=2", origin)).toBe("https://legal.test/documents/1?page=2");
    expect(safeUrl("https://law.example/act", origin)).toBe("https://law.example/act");
    expect(safeUrl("//evil.example/x", origin)).toBeNull();
    expect(safeUrl("javascript:alert(1)", origin)).toBeNull();
    expect(safeUrl("http://plain.example", origin)).toBeNull();
  });
});
