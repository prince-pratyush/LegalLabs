import { randomUUID } from "node:crypto";
import { AwsClient } from "aws4fetch";
import { beforeAll, describe, expect, it } from "vitest";
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
      expect(await make().getRange(contentKey(randomUUID(), SHA), 0, 1)).toBeNull();
    });

    it("returns a byte range, both ends included", async () => {
      const store = make();
      const key = contentKey(randomUUID(), SHA);
      await store.putIfAbsent(key, bytes("hello world"));
      const range = (await store.getRange(key, 6, 9)) ?? new Uint8Array();
      expect(new TextDecoder().decode(range)).toBe("worl");
    });

    it("streams a whole object, and nothing for a missing key", async () => {
      const store = make();
      const key = contentKey(randomUUID(), SHA);
      await store.putIfAbsent(key, bytes("hello world"));
      const stream = await store.stream(key);
      expect(await new Response(stream).text()).toBe("hello world");
      expect(await store.stream(contentKey(randomUUID(), SHA))).toBeNull();
    });

    it("deletes a key, and deleting it again is fine", async () => {
      const store = make();
      const key = contentKey(randomUUID(), SHA);
      await store.putIfAbsent(key, bytes("gone"));
      await store.delete(key);
      await store.delete(key);
      expect(await store.get(key)).toBeNull();
    });
  });
}

contract("memory store", createMemoryStore);

const endpoint = process.env.TEST_S3_ENDPOINT;
if (endpoint) {
  const s3 = { endpoint, bucket: "legallabs-test", region: "us-east-1" };
  const keys = { accessKeyId: "test", secretAccessKey: "test" };
  beforeAll(async () => {
    const client = new AwsClient({ ...keys, region: s3.region, service: "s3" });
    const res = await client.fetch(`${endpoint}/${s3.bucket}`, { method: "PUT" });
    await res.body?.cancel();
  });
  contract("s3 store", () => createS3Store({ ...s3, ...keys }));
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
