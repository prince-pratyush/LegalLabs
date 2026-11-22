import { z } from "zod";

const noNul = (t: string) => !t.includes("\0");
const text = (min: number, max: number) =>
  z.string().min(min).max(max).refine(noNul, "No NUL bytes");
const email = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(320)
  .refine((t) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t) && noNul(t), "Not an email address");
const domain = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, "Not a domain");

/** The guest organisation of an external Space, and who approves for it. */
export const PartyInput = z
  .object({
    name: z.string().trim().min(1).max(200).refine(noNul, "No NUL bytes"),
    domain,
    connection_admin_emails: z.array(email).max(10).default([]),
  })
  .strict();
export type PartyInput = z.infer<typeof PartyInput>;

export const PartyRejectInput = z
  .object({ reason: z.string().trim().max(1000).optional() })
  .strict();
export type PartyRejectInput = z.infer<typeof PartyRejectInput>;

export const GuestInviteInput = z
  .object({ email, access_days: z.number().int().min(1).max(365).default(90) })
  .strict();
export type GuestInviteInput = z.infer<typeof GuestInviteInput>;

const token = z
  .string()
  .min(20)
  .max(200)
  .regex(/^[\w-]+$/);
export const GuestPreviewInput = z.object({ token }).strict();
export const GuestAcceptInput = z
  .object({ token, name: z.string().trim().min(1).max(200).refine(noNul, "No NUL bytes") })
  .strict();

export const GuestLoginCodeInput = z.object({ workspace: text(1, 63), email }).strict();
export const GuestLoginVerifyInput = z
  .object({ workspace: text(1, 63), email, code: z.string().regex(/^\d{8}$/) })
  .strict();
