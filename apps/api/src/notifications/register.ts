import type { Threads } from "../threads/threads.js";
import { ActionRefused, type ActionRegistry } from "./actions.js";

/**
 * Inline actions for thread runs. The notification's object is the run, so Approve plan calls
 * the same method as the plan page, as the person clicking, and a plan someone else already
 * approved is refused the same way.
 */
export function registerThreadActions(actions: ActionRegistry, threads: Pick<Threads, "approve">) {
  actions.register(
    "thread.run.awaiting_approval",
    "approve_plan",
    async (principal, notification, _payload, client) => {
      if (!(await threads.approve(principal, notification.objectId, client))) {
        throw new ActionRefused(
          409,
          "NOT_AWAITING_APPROVAL",
          "That plan isn't waiting for approval.",
        );
      }
      return { result: "done" };
    },
  );
  // Answering happens in the thread, so the hub sends the person there.
  actions.register("thread.run.needs_input", "answer", async (_principal, notification) => ({
    result: "redirect",
    url: notification.url,
  }));
}
