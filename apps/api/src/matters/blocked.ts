import type { Context } from "hono";

/** A share refused by a matter's walls. Only the count is given, so no walled name leaks. */
export const wallShareBlocked = (c: Context, count: number) =>
  c.json(
    {
      code: "WALL_SHARE_BLOCKED",
      message: `${count} ${count === 1 ? "recipient is" : "recipients are"} blocked by an ethical wall on this matter.`,
      blocked_count: count,
    },
    403,
  );
