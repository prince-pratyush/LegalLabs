import { AwsClient } from "aws4fetch";

export interface ObjectStore {
  /** False if the key was taken, which for a content key means the same bytes. */
  putIfAbsent(key: string, bytes: Uint8Array): Promise<boolean>;
  get(key: string): Promise<Uint8Array | null>;
  /** Bytes `start` to `end`, both included, so a viewer reads one page without the whole file. */
  getRange(key: string, start: number, end: number): Promise<Uint8Array | null>;
  /** The whole object as a stream, so serving a large file never holds it all in memory. */
  stream(key: string): Promise<ReadableStream<Uint8Array> | null>;
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
  };
}

export function objectStoreFromEnv(env: Record<string, string | undefined>): ObjectStore {
  const need = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };
  return createS3Store({
    endpoint: need("S3_ENDPOINT"),
    bucket: need("S3_BUCKET"),
    region: env.S3_REGION ?? "us-east-1",
    accessKeyId: need("S3_ACCESS_KEY_ID"),
    secretAccessKey: need("S3_SECRET_ACCESS_KEY"),
  });
}
