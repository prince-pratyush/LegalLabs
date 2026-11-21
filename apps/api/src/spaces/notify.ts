import type { NotificationEvent, Notifier } from "../notifications/notify.js";
import type { NotifyEvent, SpaceNotifier } from "./kit.js";

/** Turns what Spaces reports into the hub's typed events, so Spaces never knows the catalogue. */
export function toHubEvent(actorId: string, event: NotifyEvent): NotificationEvent | null {
  switch (event.kind) {
    case "mention":
      return {
        kind: "task.mentioned",
        actorId,
        objectType: "task",
        objectId: event.taskId ?? event.spaceId,
        objectTitle: event.title,
        people: { mentioned: event.userIds },
      };
    case "task.assigned":
      return {
        kind: "task.assigned",
        actorId,
        objectType: "task",
        objectId: event.taskId ?? event.spaceId,
        objectTitle: event.title,
        people: event.userIds[0] ? { assignee: event.userIds[0] } : {},
      };
    case "task.returned":
      // No actor: the creator hears of it even when they are the one who read the task.
      return {
        kind: "task.status_changed",
        actorId: null,
        objectType: "task",
        objectId: event.taskId ?? event.spaceId,
        objectTitle: event.title,
        people: event.userIds[0] ? { creator: event.userIds[0] } : {},
      };
    case "space.access_requested":
      return {
        kind: "space.request_access",
        actorId,
        objectType: "space",
        objectId: event.spaceId,
        objectTitle: event.title,
        people: { admins: event.userIds },
      };
    case "space.access_decided":
      // Only a yes is worth a notification; a no is for the admin to tell them.
      return event.accepted
        ? {
            kind: "space.invited",
            actorId,
            objectType: "space",
            objectId: event.spaceId,
            objectTitle: event.title,
            people: { recipients: event.userIds },
          }
        : null;
  }
}

export function spaceNotifier(notifier: Notifier): SpaceNotifier {
  return {
    async notify(p, event) {
      const hub = toHubEvent(p.actorId, event);
      if (!hub) return;
      // The hub checks each recipient's walls itself; it never throws.
      await notifier.notify({ sessionId: "", userId: p.actorId, workspaceId: p.workspaceId }, hub);
    },
  };
}
