import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { Principal } from "../auth/auth.js";
import { outlookHttp } from "./http.js";
import type { Outlook } from "./outlook.js";

/** The routes alone: nothing here gets far enough to store an email. */
function routes(bodyMs: number) {
  const app = new Hono<{ Variables: { principal: Principal } }>();
  app.use(async (c, next) => {
    c.set("principal", { userId: c.req.header("x-user") ?? "", workspaceId: "w", sessionId: "s" });
    await next();
  });
  app.route(
    "/",
    outlookHttp({} as Outlook, () => ({ ip: null, userAgent: null }), Date.now, bodyMs),
  );
  const post = (user: string, body: ReadableStream | string) =>
    app.request("/items", {
      method: "POST",
      headers: { "x-user": user, "content-type": "multipart/form-data; boundary=x" },
      body,
      duplex: "half",
    } as RequestInit);
  return { post };
}

// A body that starts and never ends.
const trickle = () =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("--x\r\n"));
    },
  });

describe("receiving an email", () => {
  it("lets one person hold only one upload, so others still get through", async () => {
    const { post } = routes(300);
    const slow = post("ana", trickle());
    expect((await post("ana", trickle())).status).toBe(429);
    expect((await post("ana", trickle())).status).toBe(429);
    expect((await post("ben", "--x--")).status).toBe(400);
    expect((await slow).status).toBe(408);
  });

  it("gives up on a body that takes too long, and frees the place", async () => {
    const { post } = routes(50);
    const stalled = await Promise.all([post("ana", trickle()), post("ben", trickle())]);
    expect(stalled.map((res) => res.status)).toEqual([408, 408]);
    expect((await post("cat", "--x--")).status).toBe(400);
    expect((await post("ana", "--x--")).status).toBe(400);
  });
});
