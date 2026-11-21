import type { NotificationActResult } from "@legallabs/contracts";
import type { Client, Principal } from "../auth/auth.js";

/** The part of a notification a handler needs; its owner module knows what to do with it. */
export interface ActionTarget {
  id: string;
  kind: string;
  objectType: string;
  objectId: string;
  url: string;
}

/** Throw this to refuse an action with a message the person can read. */
export class ActionRefused extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type ActionHandler = (
  principal: Principal,
  notification: ActionTarget,
  payload: Record<string, unknown>,
  client: Client,
) => Promise<NotificationActResult>;

/**
 * Inline actions are owned by the modules the notification is about. A module registers a
 * handler for (kind, action) and the hub calls it with the caller's own authority, so the
 * hub never decides who may approve or answer.
 */
export interface ActionRegistry {
  register(kind: string, actionId: string, handler: ActionHandler): void;
  find(kind: string, actionId: string): ActionHandler | undefined;
}

export function createActionRegistry(): ActionRegistry {
  const handlers = new Map<string, ActionHandler>();
  const key = (kind: string, action: string) => `${kind}\u0000${action}`;
  return {
    register(kind, actionId, handler) {
      handlers.set(key(kind, actionId), handler);
    },
    find: (kind, actionId) => handlers.get(key(kind, actionId)),
  };
}
