// Reading a body from someone who has not been authenticated yet: capped while it streams,
// dropped when it stalls, and only so many held at once for any one source.

export interface ReadLimits {
  max: number;
  /** How long a body may send nothing before it is dropped. */
  idleMs: number;
  /** How long it may take in all. */
  deadlineMs: number;
}

/** The body, unless it passes the cap, goes quiet or takes too long in all. */
export async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  { max, idleMs, deadlineMs }: ReadLimits,
): Promise<Buffer | "large" | "late"> {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let late = false;
  const drop = () => {
    late = true;
    reader.cancel().catch(() => {});
  };
  const deadline = setTimeout(drop, deadlineMs);
  let idle = setTimeout(drop, idleMs);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (late) return "late";
      if (done) return Buffer.concat(chunks);
      clearTimeout(idle);
      idle = setTimeout(drop, idleMs);
      size += value.length;
      if (size > max) {
        reader.cancel().catch(() => {});
        return "large";
      }
      chunks.push(value);
    }
  } finally {
    clearTimeout(deadline);
    clearTimeout(idle);
  }
}

/** Counts what is in progress for each key. */
export function places(max: number) {
  const held = new Map<string, number>();
  return {
    full: (key: string) => (held.get(key) ?? 0) >= max,
    take(key: string) {
      held.set(key, (held.get(key) ?? 0) + 1);
    },
    free(key: string) {
      const left = (held.get(key) ?? 1) - 1;
      if (left > 0) held.set(key, left);
      else held.delete(key);
    },
  };
}
