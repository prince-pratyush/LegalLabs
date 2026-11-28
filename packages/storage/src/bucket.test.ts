import { describe, expect, it } from "vitest";
import { ensureBucket, isPublicBucket, type S3Config } from "./index.js";

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
