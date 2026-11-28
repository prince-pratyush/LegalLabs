import { describe, expect, it } from "vitest";
import { ensureBucket, isPublicBucket, listKeys, type S3Config } from "./index.js";

// Array.fromAsync is newer than the language level the packages compile to.
const all = async <T>(items: AsyncIterable<T>) => {
  const found: T[] = [];
  for await (const item of items) found.push(item);
  return found;
};

const config = (answer: (url: string, signed: boolean, method: string) => number): S3Config => ({
  endpoint: "http://store:8333",
  bucket: "files",
  region: "us-east-1",
  accessKeyId: "key",
  secretAccessKey: "secret",
  fetch: (async (input: Request | string, init?: RequestInit) => {
    const request = new Request(input, init);
    const signed = request.headers.has("authorization");
    return new Response(null, { status: answer(request.url, signed, request.method) });
  }) as typeof fetch,
});

describe("isPublicBucket", () => {
  it("is private when anonymous requests are refused", async () => {
    expect(await isPublicBucket(config((_u, signed) => (signed ? 200 : 403)))).toBe(false);
  });

  it("is public when anyone may list it", async () => {
    expect(
      await isPublicBucket(
        config((url, signed) => (signed || url.includes("list-type") ? 200 : 403)),
      ),
    ).toBe(true);
  });

  it("is public when anyone may read an object in it", async () => {
    expect(
      await isPublicBucket(
        config((url, signed) => (!signed && url.includes("list-type") ? 403 : 200)),
      ),
    ).toBe(true);
  });

  it("fails rather than guess when the store errors", async () => {
    await expect(isPublicBucket(config((_u, signed) => (signed ? 200 : 500)))).rejects.toThrow(
      /500/,
    );
  });
});

describe("ensureBucket", () => {
  it("creates the bucket, and accepts one that exists", async () => {
    const seen: string[] = [];
    await ensureBucket(
      config((url, signed, method) => (seen.push(`${method} ${url} ${signed}`), 200)),
    );
    expect(seen).toEqual(["PUT http://store:8333/files true"]);
    await expect(ensureBucket(config(() => 409))).resolves.toBeUndefined();
    await expect(ensureBucket(config(() => 403))).rejects.toThrow(/403/);
  });
});

describe("listKeys", () => {
  const page = (keys: string[], next?: string) =>
    `<ListBucketResult>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join("")}<IsTruncated>${Boolean(next)}</IsTruncated>${next ? `<NextContinuationToken>${next}</NextContinuationToken>` : ""}</ListBucketResult>`;

  it("follows every page and decodes names", async () => {
    const asked: string[] = [];
    const config: S3Config = {
      ...config200,
      fetch: (async (input: Request) => {
        asked.push(new URL(input.url).searchParams.get("continuation-token") ?? "");
        return new Response(asked.length === 1 ? page(["a/1", "a&amp;b"], "t/2=") : page(["c"]));
      }) as typeof fetch,
    };
    expect(await all(listKeys(config))).toEqual(["a/1", "a&b", "c"]);
    expect(asked).toEqual(["", "t/2="]);
  });

  it("fails on a refused listing, never returning an empty one", async () => {
    await expect(all(listKeys(config(() => 403)))).rejects.toThrow(/403/);
  });
});

const config200 = config(() => 200);
