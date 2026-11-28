import { AwsClient } from "aws4fetch";

export interface ObjectStore {
  /** False if the key was taken, which for a content key means the same bytes. */
  putIfAbsent(key: string, bytes: Uint8Array): Promise<boolean>;
  get(key: string): Promise<Uint8Array | null>;
  /** Bytes `start` to `end`, both included, so a viewer reads one page without the whole file. */
  getRange(key: string, start: number, end: number): Promise<Uint8Array | null>;
  /** The whole object as a stream, so serving a large file never holds it all in memory. */
  stream(key: string): Promise<ReadableStream<Uint8Array> | null>;
  /** Removes a key; a missing key is not an error, so a purge can be run again. */
  delete(key: string): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** Workspaces never share an object, even for identical bytes. */
export function contentKey(workspaceId: string, sha256Hex: string): string {
  if (!UUID.test(workspaceId) || !SHA256.test(sha256Hex)) throw new Error("invalid content key");
  return `workspaces/${workspaceId}/sha256/${sha256Hex}`;
}

export function createMemoryStore(): ObjectStore {
  const objects = new Map<string, Uint8Array>();
  return {
    async putIfAbsent(key, bytes) {
      if (objects.has(key)) return false;
      objects.set(key, bytes.slice());
      return true;
    },
    async get(key) {
      return objects.get(key)?.slice() ?? null;
    },
    async getRange(key, start, end) {
      return objects.get(key)?.slice(start, end + 1) ?? null;
    },
    async stream(key) {
      const bytes = objects.get(key);
      return bytes ? new Blob([bytes.slice()]).stream() : null;
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

export interface S3Config {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

// Path-style URLs, because SeaweedFS and most self-hosted servers expect them.
export function createS3Store(config: S3Config): ObjectStore {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region,
    service: "s3",
  });
  const send = config.fetch ?? fetch;
  const base = `${config.endpoint.replace(/\/+$/, "")}/${encodeURIComponent(config.bucket)}`;
  const url = (key: string) => `${base}/${key.split("/").map(encodeURIComponent).join("/")}`;

  async function request(
    method: string,
    key: string,
    body?: Uint8Array,
    headers?: Record<string, string>,
  ): Promise<Response> {
    const signed = await client.sign(url(key), {
      method,
      // A stalled store would otherwise hold an upload open forever.
      signal: AbortSignal.timeout(config.timeoutMs ?? 30_000),
      ...(body ? { body, headers: { "content-type": "application/octet-stream" } } : {}),
      ...(headers ? { headers } : {}),
    });
    const response = await send(signed);
    if (!response.ok && response.status !== 404) {
      await response.body?.cancel();
      // The body can echo the request, so only the status is kept.
      throw new Error(`object store ${method} failed with ${response.status}`);
    }
    return response;
  }

  return {
    async putIfAbsent(key, bytes) {
      const head = await request("HEAD", key);
      if (head.ok) return false;
      await (await request("PUT", key, bytes)).body?.cancel();
      return true;
    },
    async get(key) {
      const response = await request("GET", key);
      if (response.status === 404) return null;
      return new Uint8Array(await response.arrayBuffer());
    },
    async getRange(key, start, end) {
      const response = await request("GET", key, undefined, { range: `bytes=${start}-${end}` });
      if (response.status === 404) return null;
      const bytes = new Uint8Array(await response.arrayBuffer());
      // A store that ignores Range sends the whole object with a 200.
      return response.status === 206 ? bytes : bytes.slice(start, end + 1);
    },
    async stream(key) {
      const response = await request("GET", key);
      if (response.status === 404) return null;
      return response.body;
    },
    async delete(key) {
      await (await request("DELETE", key)).body?.cancel();
    },
  };
}

export function s3ConfigFromEnv(env: Record<string, string | undefined>): S3Config {
  const need = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };
  return {
    endpoint: need("S3_ENDPOINT"),
    bucket: need("S3_BUCKET"),
    region: env.S3_REGION ?? "us-east-1",
    accessKeyId: need("S3_ACCESS_KEY_ID"),
    secretAccessKey: need("S3_SECRET_ACCESS_KEY"),
  };
}

export function objectStoreFromEnv(env: Record<string, string | undefined>): ObjectStore {
  return createS3Store(s3ConfigFromEnv(env));
}

const bucketUrl = (config: S3Config) =>
  `${config.endpoint.replace(/\/+$/, "")}/${encodeURIComponent(config.bucket)}`;

async function signedSend(config: S3Config, url: string, init: RequestInit): Promise<Response> {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region,
    service: "s3",
  });
  const signed = await client.sign(url, { ...init, signal: AbortSignal.timeout(30_000) });
  return (config.fetch ?? fetch)(signed);
}

/** Creates the bucket; one that is already there is fine. */
export async function ensureBucket(config: S3Config): Promise<void> {
  const response = await signedSend(config, bucketUrl(config), { method: "PUT" });
  await response.body?.cancel();
  if (!response.ok && response.status !== 409) {
    throw new Error(`creating bucket ${config.bucket} failed with ${response.status}`);
  }
}

const PROBE = ".legallabs/public-probe";

/** Whether someone with no credentials can list the bucket or read from it (SEC-002). */
export async function isPublicBucket(config: S3Config): Promise<boolean> {
  // Written first, so an anonymous read has something real to be refused.
  await createS3Store(config).putIfAbsent(PROBE, new TextEncoder().encode("probe"));
  const send = config.fetch ?? fetch;
  for (const url of [
    `${bucketUrl(config)}?list-type=2&max-keys=1`,
    `${bucketUrl(config)}/${PROBE}`,
  ]) {
    const response = await send(new Request(url, { signal: AbortSignal.timeout(30_000) }));
    await response.body?.cancel();
    if (response.ok) return true;
    if (response.status >= 500) {
      throw new Error(`checking bucket ${config.bucket} failed with ${response.status}`);
    }
  }
  return false;
}

const XML: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decodeXml = (text: string) =>
  text.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (all, name: string) =>
    name.startsWith("#")
      ? String.fromCodePoint(Number(`0${name.slice(1)}`.replace(/^0(?!x)/, "")))
      : (XML[name] ?? all),
  );

/** Every key in the bucket, a page at a time. Used by backup. */
export async function* listKeys(config: S3Config): AsyncGenerator<string> {
  let token: string | undefined;
  do {
    const url = new URL(bucketUrl(config));
    url.searchParams.set("list-type", "2");
    if (token) url.searchParams.set("continuation-token", token);
    const response = await signedSend(config, url.toString(), { method: "GET" });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`listing bucket ${config.bucket} failed with ${response.status}`);
    }
    const body = await response.text();
    for (const match of body.matchAll(/<Key>([^<]*)<\/Key>/g)) yield decodeXml(match[1] ?? "");
    token = /<IsTruncated>true<\/IsTruncated>/.test(body)
      ? decodeXml(/<NextContinuationToken>([^<]*)</.exec(body)?.[1] ?? "")
      : undefined;
  } while (token);
}
