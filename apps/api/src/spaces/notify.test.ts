import { describe, expect, it } from "vitest";
import { CATALOGUE } from "../notifications/catalogue.js";
import type { NotifyEvent } from "./kit.js";
import { toHubEvent } from "./notify.js";

const base = { spaceId: "s", taskId: "t", title: "Review the MSA" } as const;
const event = (e: Partial<NotifyEvent> & Pick<NotifyEvent, "kind" | "userIds">): NotifyEvent => ({
  ...base,
  ...e,
});

describe("Spaces events in the notifications hub", () => {
  it("tells mentioned people about a task, naming the task and not the comment", () => {
    const hub = toHubEvent("actor", event({ kind: "mention", userIds: ["ben"] }));
    expect(hub).toMatchObject({
      kind: "task.mentioned",
      objectType: "task",
      objectId: "t",
      objectTitle: "Review the MSA",
      people: { mentioned: ["ben"] },
    });
    expect(hub?.detail).toBeUndefined();
  });

  it("tells a task's creator it came back, even if they are the one who read it", () => {
    const hub = toHubEvent("ana", event({ kind: "task.returned", userIds: ["ana"] }));
    expect(hub?.actorId).toBeNull();
    const recipients = hub ? CATALOGUE[hub.kind].recipients(hub) : [];
    expect(recipients).toEqual(["ana"]);
  });

  it("tells a Space's admins about a request to join", () => {
    const hub = toHubEvent(
      "ben",
      event({ kind: "space.access_requested", userIds: ["ana"], title: "Deal room" }),
    );
    expect(hub).toMatchObject({ kind: "space.request_access", objectType: "space", objectId: "s" });
    expect(hub ? CATALOGUE[hub.kind].recipients(hub) : []).toEqual(["ana"]);
  });

  it("tells someone whose request was accepted, and no one when it was denied", () => {
    const yes = toHubEvent(
      "ana",
      event({ kind: "space.access_decided", userIds: ["ben"], accepted: true }),
    );
    expect(yes?.kind).toBe("space.invited");
    expect(yes ? CATALOGUE[yes.kind].recipients(yes) : []).toEqual(["ben"]);
    expect(
      toHubEvent("ana", event({ kind: "space.access_decided", userIds: ["ben"], accepted: false })),
    ).toBeNull();
  });
});
