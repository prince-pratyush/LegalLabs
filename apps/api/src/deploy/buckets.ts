import { isPublicBucket, s3ConfigFromEnv } from "@legallabs/storage";

/** The content bucket and, when set, the anchor bucket, if either is open to anyone. */
export async function publicBuckets(env: Record<string, string | undefined>): Promise<string[]> {
  const config = s3ConfigFromEnv(env);
  const open: string[] = [];
  for (const bucket of new Set([config.bucket, env.S3_ANCHOR_BUCKET || config.bucket])) {
    if (await isPublicBucket({ ...config, bucket })) open.push(bucket);
  }
  return open;
}
