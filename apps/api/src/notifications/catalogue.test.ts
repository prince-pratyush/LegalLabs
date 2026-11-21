import { NOTIFICATION_KINDS, type NotificationKind, notificationKinds } from "@legallabs/contracts";
import { describe, expect, it } from "vitest";
import { CATALOGUE, type NotificationEvent } from "./catalogue.js";

const U = (n: number) => `00000000-0000-7000-8000-00000000000${n}`;

/** An event naming every role, so each recipient resolver has someone to return. */
const event = (kind: NotificationKind): NotificationEvent => ({
  kind,
  actorId: U(9),
  objectType: "thread",
  objectId: U(8),
  objectTitle: "Supply agreement",
  detail: "SECRET-COMMENT-TEXT",
  people: {
    owner: U(1),
    runner: U(1),
    recipients: [U(1)],
    assignee: U(1),
    creator: U(1),
    requester: U(1),
    mentioned: [U(1)],
    approvers: [U(1)],
    admins: [U(1)],
    participants: [U(1)],
    optedIn: [U(1)],
  },
});

describe("the notification catalogue", () => {
  it("covers exactly the kinds in the contract", () => {
    expect(Object.keys(CATALOGUE).sort()).toEqual([...notificationKinds].sort());
  });

  it.each(notificationKinds)(
    "%s has a category, resolver, link, title and email template",
    (kind) => {
      const entry = CATALOGUE[kind];
      const meta = NOTIFICATION_KINDS[kind];
      expect(entry.category).toBe(meta.category);
      expect(entry.action_required).toBe(meta.action_required);
      expect(entry.in_app).toBe(meta.in_app);
      expect(entry.email).toBe(meta.email);
      expect(entry.completion).toBe(meta.completion);

      const e = event(kind);
      expect(entry.recipients(e)).toContain(U(1));
      expect(entry.link(e)).toMatch(/^#\//);
      const title = entry.title(e);
      expect(title.length).toBeGreaterThan(0);
      expect(title.length).toBeLessThanOrEqual(300);
      // The memory roll-up is about the person, not an object.
      if (kind !== "memory.candidates_pending") expect(title).toContain("Supply agreement");
      expect(entry.template.subject(e).length).toBeGreaterThan(0);
      expect(entry.template.text(e).length).toBeGreaterThan(0);
    },
  );

  it("never puts comment text in an email template", () => {
    for (const kind of notificationKinds) {
      const e = event(kind);
      const entry = CATALOGUE[kind];
      expect(entry.template.subject(e)).not.toContain("SECRET-COMMENT-TEXT");
      expect(entry.template.text(e)).not.toContain("SECRET-COMMENT-TEXT");
      expect(entry.title(e)).not.toContain("SECRET-COMMENT-TEXT");
    }
  });

  it("offers an inline action on every action-required event", () => {
    for (const kind of notificationKinds) {
      const entry = CATALOGUE[kind];
      if (entry.action_required && entry.in_app) {
        expect(entry.actions?.length, kind).toBeGreaterThan(0);
      }
    }
  });

  it("links a run's events to its thread when told to", () => {
    const e = { ...event("thread.run.failed"), objectType: "run", url: "#/t/abc" };
    expect(CATALOGUE["thread.run.failed"].link(e)).toBe("#/t/abc");
    expect(CATALOGUE["vault.shared"].link({ ...event("vault.shared"), objectType: "vault" })).toBe(
      `#/vaults/${U(8)}`,
    );
  });

  it("keeps in-app bodies to comment and question kinds", () => {
    const withBody = notificationKinds.filter((k) => CATALOGUE[k].body).sort();
    expect(withBody).toEqual(
      [
        "table.cell_commented",
        "table.cell_mentioned",
        "task.commented",
        "task.mentioned",
        "thread.mentioned",
        "thread.run.needs_input",
      ].sort(),
    );
  });
});
