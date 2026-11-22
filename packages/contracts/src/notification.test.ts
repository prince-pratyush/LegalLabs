import { describe, expect, it } from "vitest";
import {
  AdminNotificationSettingsPatch,
  CATEGORY_LABELS,
  EmailCategory,
  isRelativeLink,
  NOTIFICATION_KINDS,
  NotificationActBody,
  NotificationActResult,
  NotificationCategory,
  NotificationPatch,
  NotificationQuery,
  NotificationSettingsPatch,
  notificationKinds,
  QuietHours,
} from "./notification.js";

describe("notification kinds", () => {
  it("name the 43 catalogue events, each in a known category", () => {
    expect(notificationKinds).toHaveLength(43);
    for (const kind of notificationKinds) {
      expect(NotificationCategory.safeParse(NOTIFICATION_KINDS[kind].category).success).toBe(true);
    }
  });

  it("use dotted lowercase names", () => {
    for (const kind of notificationKinds) expect(kind).toMatch(/^[a-z]+(\.[a-z_]+)+$/);
  });

  it("label every category", () => {
    for (const category of NotificationCategory.options) {
      expect(CATEGORY_LABELS[category].length).toBeGreaterThan(0);
    }
  });

  it("keep the horizon digest email-only and the memory roll-up in-app-only", () => {
    expect(NOTIFICATION_KINDS["horizon.digest"]).toMatchObject({ in_app: false, email: true });
    expect(NOTIFICATION_KINDS["memory.candidates_pending"]).toMatchObject({
      in_app: true,
      email: false,
    });
    expect(EmailCategory.safeParse("memory").success).toBe(false);
  });

  it("make the catalogue's action-required events action required", () => {
    const required = notificationKinds.filter((k) => NOTIFICATION_KINDS[k].action_required);
    expect(required).toEqual(
      expect.arrayContaining([
        "thread.run.needs_input",
        "thread.run.awaiting_approval",
        "agent.share_requested",
        "task.assigned",
        "task.gate_pending",
        "task.due_soon",
        "knowledge.source.degraded",
      ]),
    );
    expect(NOTIFICATION_KINDS["thread.shared"].action_required).toBe(false);
  });
});

describe("notification requests", () => {
  it("default the list to all, unread and read", () => {
    expect(NotificationQuery.parse({})).toEqual({ tab: "all", state: "unread_read" });
    expect(NotificationQuery.safeParse({ tab: "nope" }).success).toBe(false);
  });

  it("need something to change on a patch", () => {
    expect(NotificationPatch.safeParse({}).success).toBe(false);
    expect(NotificationPatch.safeParse({ read: true }).success).toBe(true);
    expect(NotificationPatch.safeParse({ read: true, other: 1 }).success).toBe(false);
  });

  it("take an action id and an optional payload", () => {
    expect(NotificationActBody.safeParse({ action: "approve_plan" }).success).toBe(true);
    expect(NotificationActBody.safeParse({ action: "" }).success).toBe(false);
  });

  it("check quiet hours' clock times", () => {
    expect(
      QuietHours.safeParse({ from: "22:00", to: "07:00", tz: "Australia/Sydney" }).success,
    ).toBe(true);
    expect(QuietHours.safeParse({ from: "24:00", to: "07:00", tz: "UTC" }).success).toBe(false);
    expect(QuietHours.safeParse({ from: "9:00", to: "07:00", tz: "UTC" }).success).toBe(false);
  });

  it("accept only email categories in settings", () => {
    expect(
      NotificationSettingsPatch.safeParse({ categories: [{ category: "vault", value: true }] })
        .success,
    ).toBe(true);
    expect(
      NotificationSettingsPatch.safeParse({ categories: [{ category: "memory", value: true }] })
        .success,
    ).toBe(false);
    expect(NotificationSettingsPatch.safeParse({ quiet_hours: null }).success).toBe(true);
    expect(
      AdminNotificationSettingsPatch.safeParse({
        categories: [{ category: "vault", locked: true }],
        include_content: true,
      }).success,
    ).toBe(true);
  });

  it("allows only in-app links", () => {
    for (const ok of ["#/t/abc", "#/", "/d/123?x=1", "#/settings/memory"]) {
      expect(isRelativeLink(ok), ok).toBe(true);
    }
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,x",
      "https://evil.example/x",
      "//evil.example",
      "/\\evil.example",
      "#javascript:alert(1)",
      "#/a b",
      "",
    ]) {
      expect(isRelativeLink(bad), bad).toBe(false);
    }
    expect(
      NotificationActResult.safeParse({ result: "redirect", url: "javascript:x" }).success,
    ).toBe(false);
    expect(NotificationActResult.safeParse({ result: "redirect", url: "#/t/1" }).success).toBe(
      true,
    );
  });
});
