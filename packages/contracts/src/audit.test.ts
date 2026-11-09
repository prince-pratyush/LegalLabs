import { describe, expect, it } from "vitest";
import { AuditAction, AuditActorType, auditActions } from "./index.js";

describe("AuditAction", () => {
  it.each([
    "logout",
    "login.failure",
    "scim.user_deactivated",
    "settings.changed",
    "memory.restored",
    "document.previewed",
    "share.link_disabled",
    "wall.denied",
    "wall.share_blocked",
    "wall.sync_applied",
    "model.refused_no_zdr",
    "tool.approval_denied",
    "export.legal_hold",
  ])("accepts %s", (action) => {
    expect(AuditAction.safeParse(action).success).toBe(true);
  });

  it.each(["wall.access_blocked", "wall.share_denied", "wall.sync.finished", "wall.rule.created"])(
    "rejects %s, which is not the official name",
    (action) => {
      expect(AuditAction.safeParse(action).success).toBe(false);
    },
  );

  it("rejects document verbs on objects that do not have them", () => {
    expect(AuditAction.safeParse("thread.quarantined").success).toBe(false);
  });

  it("lists each name once", () => {
    expect(new Set(auditActions).size).toBe(auditActions.length);
  });

  it("uses only names the database accepts", () => {
    const rejected = auditActions.filter((a) => !/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/.test(a));
    expect(rejected).toEqual([]);
  });
});

describe("AuditActorType", () => {
  it("names who can act", () => {
    expect(AuditActorType.options).toEqual(["user", "service", "system", "agent"]);
  });
});
