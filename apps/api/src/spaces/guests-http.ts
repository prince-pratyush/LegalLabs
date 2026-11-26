import {
  GuestAcceptInput,
  GuestInviteInput,
  GuestLoginCodeInput,
  GuestLoginVerifyInput,
  GuestPreviewInput,
  PartyInput,
  PartyRejectInput,
} from "@legallabs/contracts";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { z } from "zod";
import type { Client, Principal } from "../auth/auth.js";
import { createLimiter } from "../auth/limiter.js";
import {
  GUEST_SESSION_SECONDS,
  type GuestSpaceSummary,
  type GuestSpaceView,
  type Guests,
  type GuestView,
  type PartyView,
} from "./guests.js";
import { FAILURES } from "./http.js";
import type { Result } from "./kit.js";

type Env = { Variables: { principal: Principal } };

const small = bodyLimit({
  maxSize: 8 * 1024,
  onError: (c) => c.json({ code: "INVALID_REQUEST", message: "That was too large." }, 400),
});
const invalid = (c: Context) =>
  c.json({ code: "INVALID_REQUEST", message: "Check the details and try again." }, 400);
const notFound = (c: Context) => c.json({ code: "NOT_FOUND", message: "That wasn't found." }, 404);

const partyJson = (p: PartyView) => ({
  id: p.id,
  name: p.name,
  domain: p.domain,
  connection_admin_emails: p.connectionAdminEmails,
  connection: {
    status: p.connection.status,
    approvals: p.connection.approvals,
    rejected_reason: p.connection.rejectedReason,
  },
  created_at: p.createdAt,
});
const guestJson = (g: GuestView) => ({
  user_id: g.userId,
  email: g.email,
  name: g.name,
  party_id: g.partyId,
  expires_at: g.expiresAt,
  status: g.status,
});
const summaryJson = (s: GuestSpaceSummary) => ({
  space_id: s.spaceId,
  space_name: s.spaceName,
  party_id: s.partyId,
  party_name: s.partyName,
  connection_status: s.connectionStatus,
  can_approve: s.canApprove,
  expires_at: s.expiresAt,
});
const guestSpaceJson = (v: GuestSpaceView) => ({
  space: {
    id: v.space.id,
    name: v.space.name,
    kind: v.space.kind,
    workspace_name: v.space.workspaceName,
  },
  party: v.party,
  resources: v.resources.map((r) => ({
    id: r.id,
    resource_type: r.resourceType,
    resource_id: r.resourceId,
    name: r.name,
    access: r.access,
  })),
});

function helpers(clientOf: (c: Context) => Client) {
  const respond = <T>(
    c: Context,
    result: Result<T>,
    json: (value: T) => object,
    status: 200 | 201 = 200,
  ) => {
    if (!result.ok) {
      const failure = FAILURES[result.reason];
      return c.json({ code: result.reason, message: failure.message }, failure.status);
    }
    return c.json(json(result.value), status);
  };
  const empty = (c: Context, result: Result<null>) =>
    result.ok ? c.body(null, 204) : respond(c, result, () => ({}));
  const body = async <S extends z.ZodType>(c: Context, schema: S) => {
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    return parsed.success ? (parsed.data as z.output<S>) : null;
  };
  return {
    respond,
    empty,
    body,
    client: clientOf,
    param: (c: Context, n: string) => c.req.param(n) ?? "",
  };
}

/**
 * Parties, connection approval and guest invitations: for people in the workspace. A guest is
 * refused on all of these by the guard on /api/v1, and the database refuses them again.
 */
export function guestAdminRoutes(guests: Guests, clientOf: (c: Context) => Client) {
  const { respond, empty, body, client, param } = helpers(clientOf);
  const app = new Hono<Env>();
  const me = (c: Context<Env>) => c.get("principal");

  app.post("/spaces/:id/parties", small, async (c) => {
    const input = await body(c, PartyInput);
    if (!input) return invalid(c);
    const result = await guests.addParty(me(c), param(c, "id"), input, client(c));
    return respond(c, result, (p) => ({ party: partyJson(p) }), 201);
  });
  app.get("/spaces/:id/parties", async (c) => {
    const list = await guests.parties(me(c), param(c, "id"));
    return list ? c.json({ parties: list.map(partyJson) }) : notFound(c);
  });
  app.delete("/spaces/:id/parties/:pid", async (c) =>
    empty(c, await guests.removeParty(me(c), param(c, "id"), param(c, "pid"), client(c))),
  );
  app.post("/spaces/:id/parties/:pid/approve", async (c) =>
    respond(c, await guests.approve(me(c), param(c, "id"), param(c, "pid"), client(c)), (r) => ({
      status: r.status,
    })),
  );
  app.post("/spaces/:id/parties/:pid/reject", small, async (c) => {
    const input = await body(c, PartyRejectInput);
    if (!input) return invalid(c);
    return empty(
      c,
      await guests.reject(me(c), param(c, "id"), param(c, "pid"), input.reason, client(c)),
    );
  });

  app.post("/spaces/:id/guests", small, async (c) => {
    const input = await body(c, GuestInviteInput);
    if (!input) return invalid(c);
    const result = await guests.invite(me(c), param(c, "id"), input, client(c));
    // The token is shown here and nowhere else: only its hash is kept.
    return respond(
      c,
      result,
      (i) => ({
        invite: { id: i.id, email: i.email, access_days: i.accessDays },
        token: i.token,
        accept_url: i.acceptUrl,
      }),
      201,
    );
  });
  app.get("/spaces/:id/guests", async (c) =>
    respond(c, await guests.guests(me(c), param(c, "id")), (list) => ({
      guests: list.map(guestJson),
    })),
  );
  app.delete("/spaces/:id/guests/:userId", async (c) =>
    empty(c, await guests.removeGuest(me(c), param(c, "id"), param(c, "userId"), client(c))),
  );
  return app;
}

/** What a signed-in guest may do, under /api/v1/guest. Everyone else is refused here. */
export function guestRoutes(guests: Guests, clientOf: (c: Context) => Client) {
  const { respond, empty, body, client, param } = helpers(clientOf);
  const app = new Hono<Env>();
  const me = (c: Context<Env>) => c.get("principal");

  app.use("/guest/*", async (c, next) => {
    if (!me(c).guest) {
      return c.json({ code: "FORBIDDEN", message: "This is for guests." }, 403);
    }
    await next();
  });

  app.get("/guest/spaces", async (c) =>
    c.json({ spaces: (await guests.mySpaces(me(c))).map(summaryJson) }),
  );
  app.get("/guest/spaces/:id", async (c) =>
    respond(c, await guests.space(me(c), param(c, "id"), client(c)), guestSpaceJson),
  );
  // The guest-side Connection Admin: the party's id is the one this guest belongs to.
  const party = async (c: Context<Env>) =>
    (await guests.mySpaces(me(c))).find((s) => s.spaceId === param(c, "id"))?.partyId ?? null;
  app.post("/guest/spaces/:id/connection/approve", async (c) => {
    const partyId = await party(c);
    if (!partyId) return notFound(c);
    return respond(c, await guests.approve(me(c), param(c, "id"), partyId, client(c)), (r) => ({
      status: r.status,
    }));
  });
  app.post("/guest/spaces/:id/connection/reject", small, async (c) => {
    const input = await body(c, PartyRejectInput);
    if (!input) return invalid(c);
    const partyId = await party(c);
    if (!partyId) return notFound(c);
    return empty(c, await guests.reject(me(c), param(c, "id"), partyId, input.reason, client(c)));
  });
  return app;
}

export interface GuestPublicOptions {
  guests: Guests;
  clientOf: (c: Context) => Client;
  clientIp: (c: Context) => string | null;
  /** Sets the session cookie; the guest's lasts a day. */
  startSession: (c: Context, token: string, maxAgeSeconds?: number) => Promise<void>;
  now?: () => number;
}

/** Before anyone is signed in: the invitation token and the emailed code are the credentials. */
export function guestPublicRoutes({
  guests,
  clientOf,
  clientIp,
  startSession,
  now,
}: GuestPublicOptions) {
  const { respond, body, client } = helpers(clientOf);
  const app = new Hono();
  const perIp = createLimiter({ limit: 20, windowMs: 60_000, ...(now ? { now } : {}) });
  // Codes and guesses are counted per address apart, so one mailbox can't be flooded or ground
  // down; five wrong guesses lock the guest in the database whatever happens here.
  const perCodeAccount = createLimiter({ limit: 5, windowMs: 60_000, ...(now ? { now } : {}) });
  const perGuessAccount = createLimiter({ limit: 10, windowMs: 60_000, ...(now ? { now } : {}) });
  const perToken = createLimiter({ limit: 10, windowMs: 60_000, ...(now ? { now } : {}) });

  app.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });
  const limited = (
    c: Context,
    ...keys: [limiter: ReturnType<typeof createLimiter>, key: string][]
  ) => {
    for (const [limiter, key] of keys) {
      const wait = limiter.take(key);
      if (wait > 0) {
        c.header("Retry-After", String(wait));
        return c.json(
          { code: "TOO_MANY_ATTEMPTS", message: "Too many attempts. Wait and retry." },
          429,
        );
      }
    }
    return null;
  };
  const ip = (c: Context) => clientIp(c) ?? "unknown";

  app.post("/invites/preview", small, async (c) => {
    const input = await body(c, GuestPreviewInput);
    if (!input) return invalid(c);
    const slow = limited(c, [perIp, ip(c)], [perToken, input.token.slice(0, 16)]);
    if (slow) return slow;
    const found = await guests.preview(input.token);
    if (!found) {
      return c.json({ code: "INVITE_INVALID", message: FAILURES.INVITE_INVALID.message }, 404);
    }
    return c.json({
      email: found.email,
      space_name: found.spaceName,
      workspace_name: found.workspaceName,
      party_name: found.partyName,
      expires_at: found.expiresAt,
    });
  });

  app.post("/invites/accept", small, async (c) => {
    const input = await body(c, GuestAcceptInput);
    if (!input) return invalid(c);
    const slow = limited(c, [perIp, ip(c)], [perToken, input.token.slice(0, 16)]);
    if (slow) return slow;
    const result = await guests.accept(input.token, input.name, client(c));
    return respond(c, result, (a) => ({ workspace: a.workspaceSlug, space_id: a.spaceId }));
  });

  app.post("/login/code", small, async (c) => {
    const input = await body(c, GuestLoginCodeInput);
    if (!input) return invalid(c);
    const slow = limited(c, [perIp, ip(c)], [perCodeAccount, `${input.workspace}|${input.email}`]);
    if (slow) return slow;
    // Said to everyone alike, so it tells nothing about the address.
    if (!guests.canSendCodes()) {
      const failure = FAILURES.MAIL_UNAVAILABLE;
      return c.json({ code: "MAIL_UNAVAILABLE", message: failure.message }, failure.status);
    }
    await guests.requestCode(input.workspace, input.email, client(c));
    // The same answer whether or not the address is a guest.
    return c.body(null, 204);
  });

  app.post("/login/verify", small, async (c) => {
    const input = await body(c, GuestLoginVerifyInput);
    if (!input) return invalid(c);
    const slow = limited(c, [perIp, ip(c)], [perGuessAccount, `${input.workspace}|${input.email}`]);
    if (slow) return slow;
    const result = await guests.verifyCode(input.workspace, input.email, input.code, client(c));
    if (!result) {
      return c.json({ code: "INVALID_CODE", message: "That code didn't work." }, 401);
    }
    await startSession(c, result.token, GUEST_SESSION_SECONDS);
    return c.json({ user_id: result.principal.userId, workspace_id: result.principal.workspaceId });
  });

  return app;
}
