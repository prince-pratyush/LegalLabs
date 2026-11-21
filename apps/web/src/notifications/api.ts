import type {
  Notification,
  NotificationActResult,
  NotificationCategory,
  NotificationCounts,
  NotificationSettings,
  NotificationSettingsPatch,
} from "@legallabs/contracts";
import { request, send } from "../http.js";

export type Tab = "all" | "action_required";
export type State = "unread_read" | "unread" | "archived";

export interface Feed {
  items: Notification[];
  unread_count: number;
  action_required_count: number;
  next_cursor: string | null;
}

export interface FeedQuery {
  tab: Tab;
  state: State;
  category?: NotificationCategory | undefined;
  cursor?: string | undefined;
}

const enc = encodeURIComponent;

export const notificationsApi = {
  list: (q: FeedQuery) => {
    const params = new URLSearchParams({ tab: q.tab, state: q.state });
    if (q.category) params.set("category", q.category);
    if (q.cursor) params.set("cursor", q.cursor);
    return request<Feed>(`/notifications?${params}`);
  },
  counts: () => request<NotificationCounts>("/notifications/unread-count"),
  readAll: () => send<null>("POST", "/notifications/read-all"),
  patch: (id: string, patch: { read?: boolean; archived?: boolean }) =>
    send<unknown>("PATCH", `/notifications/${enc(id)}`, patch),
  act: (id: string, action: string) =>
    send<NotificationActResult>("POST", `/notifications/${enc(id)}/act`, { action }),
  settings: () => request<NotificationSettings>("/notification-settings"),
  patchSettings: (patch: NotificationSettingsPatch) =>
    send<NotificationSettings>("PATCH", "/notification-settings", patch),
};

export type { Notification };
