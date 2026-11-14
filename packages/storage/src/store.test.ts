import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { contentKey, createMemoryStore, createS3Store, type ObjectStore } from "./index.js";

const bytes = (text: string) => new TextEncoder().encode(text);
const SHA = "a".repeat(64);

function contract(name: string, make: () => ObjectStore) {
  describe(name, () => {
    it("returns what was stored", async () => {
      const store = make();
      const key = contentKey(randomUUID(), SHA);
      expect(await store.putIfAbsent(key, bytes("hello"))).toBe(true);
      expect(new TextDecoder().decode((await store.get(key)) ?? new Uint8Array())).toBe("hello");
    });

    it("writes a key only once", async () => {
      const store = make();
      const key = contentKey(randomUUID(), SHA);
      await store.putIfAbsent(key, bytes("first"));
      expect(await store.putIfAbsent(key, bytes("first"))).toBe(false);
    });

    it("returns null for a missing key", async () => {
      expect(await make().get(contentKey(randomUUID(), SHA))).toBeNull();
    });
  });
}

contract("memory store", createMemoryStore);

const endpoint = process.env.TEST_S3_ENDPOINT;
if (endpoint) {
  contract("s3 store", () =>
    createS3Store({
      endpoint,
      bucket: process.env.TEST_S3_BUCKET ?? "legallabs-test",
      region: "us-east-1",
      accessKeyId: process.env.TEST_S3_ACCESS_KEY ?? "test",
      secretAccessKey: process.env.TEST_S3_SECRET_KEY ?? "test",
    }),
  );
}

describe("contentKey", () => {
  it("keeps each workspace's files apart", () => {
    const ws = randomUUID();
    expect(contentKey(ws, SHA)).toBe(`workspaces/${ws}/sha256/${SHA}`);
  });

  it("refuses anything that isn't a workspace id and a hash", () => {
    expect(() => contentKey("../other", SHA)).toThrow();
    expect(() => contentKey(randomUUID(), "abc")).toThrow();
  });
});

describe("s3 store", () => {
  it("fails loudly on a server error", async () => {
    const store = createS3Store({
      endpoint: "http://127.0.0.1:9",
      bucket: "b",
      region: "us-east-1",
      accessKeyId: "x",
      secretAccessKey: "y",
      fetch: async () => new Response("nope", { status: 500 }),
    });
    await expect(store.get(contentKey(randomUUID(), SHA))).rejects.toThrow(/500/);
  });
});
