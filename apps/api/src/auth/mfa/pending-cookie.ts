import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { PENDING_SECONDS } from "./service.js";

// A sign-in that still owes a factor belongs to the browser that started it. The token is only
// ever in this cookie, so a link cannot hand someone else's sign-in to another browser, and
// neither scripts, history nor logs see it. Strict: only our own pages call the routes that
// read it, and single sign-on returns by redirect, which may set it.
const NAME = "mfa";

export const setPendingCookie = (c: Context, token: string) =>
  setCookie(c, NAME, token, {
    prefix: "host",
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/",
    maxAge: PENDING_SECONDS,
  });

export const pendingCookie = (c: Context) => getCookie(c, NAME, "host") ?? null;

export const clearPendingCookie = (c: Context) =>
  void deleteCookie(c, NAME, { prefix: "host", secure: true, path: "/" });
