import {
  CATEGORY_LABELS,
  type Notification,
  type NotificationCategory,
} from "@legallabs/contracts";
import { Button, Popover, PopoverContent, PopoverTrigger, toast, useHotkeys } from "@legallabs/ui";
import { Archive, Bell, Check } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { messageOf } from "../api.js";
import { formatDate } from "../vaults/shared.js";
import { notificationsApi, type State, type Tab } from "./api.js";

const POLL_MS = 30_000;
const STATES: { value: State; label: string }[] = [
  { value: "unread_read", label: "Unread & read" },
  { value: "unread", label: "Unread only" },
  { value: "archived", label: "Archived" },
];

/** A deep link is a hash route; anything else is a real path the server serves. */
export function openLink(url: string) {
  if (url.startsWith("#")) window.location.hash = url.slice(1);
  else window.location.assign(url);
}

interface Counts {
  unread: number;
  action_required: number;
}

/**
 * Keeps the bell's counts fresh: the server's event stream when there is one, a slow poll when
 * the stream is missing or the browser gave up on it.
 */
function useLiveCounts(onActivity: () => void) {
  const [counts, setCounts] = useState<Counts>({ unread: 0, action_required: 0 });
  const activity = useRef(onActivity);
  activity.current = onActivity;

  useEffect(() => {
    let closed = false;
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;

    const poll = () =>
      notificationsApi.counts().then(
        (c) => {
          if (!closed) setCounts({ unread: c.unread, action_required: c.action_required });
        },
        () => undefined,
      );
    const startPolling = () => {
      if (timer || closed) return;
      timer = setInterval(() => {
        poll();
        activity.current();
      }, POLL_MS);
    };

    poll();
    if (typeof EventSource === "undefined") {
      startPolling();
    } else {
      source = new EventSource("/api/v1/notifications/stream");
      source.addEventListener("counts", (event) => {
        try {
          const data = JSON.parse((event as MessageEvent<string>).data) as Counts;
          setCounts({ unread: data.unread, action_required: data.action_required });
        } catch {
          // A malformed frame is skipped; the next one carries the counts again.
        }
      });
      source.addEventListener("notification", () => activity.current());
      source.onerror = () => {
        // The browser retries on its own unless it has closed the stream (404, 429, ...).
        if (source?.readyState === 2) startPolling();
      };
    }
    return () => {
      closed = true;
      source?.close();
      if (timer) clearInterval(timer);
    };
  }, []);

  return [counts, setCounts] as const;
}

/** The bell in the sidebar and the hub it opens. */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("all");
  const [state, setState] = useState<State>("unread_read");
  const [category, setCategory] = useState<NotificationCategory | "">("");
  const [items, setItems] = useState<Notification[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);

  const [counts, setCounts] = useLiveCounts(() => setTick((n) => n + 1));

  useEffect(() => {
    if (!open) return;
    // `tick` re-reads the list when the stream says something arrived.
    void tick;
    let stale = false;
    notificationsApi.list({ tab, state, ...(category ? { category } : {}) }).then(
      (feed) => {
        if (stale) return;
        setFailed(false);
        setItems(feed.items);
        setCursor(feed.next_cursor);
        setCounts({ unread: feed.unread_count, action_required: feed.action_required_count });
      },
      () => !stale && setFailed(true),
    );
    return () => {
      stale = true;
    };
  }, [open, tab, state, category, tick, setCounts]);

  const more = () => {
    if (!cursor) return;
    notificationsApi.list({ tab, state, ...(category ? { category } : {}), cursor }).then(
      (feed) => {
        setItems((prev) => [...(prev ?? []), ...feed.items]);
        setCursor(feed.next_cursor);
      },
      (err) => toast.error(messageOf(err)),
    );
  };

  const patchItem = useCallback((id: string, change: Partial<Notification>) => {
    setItems((prev) => prev?.map((n) => (n.id === id ? { ...n, ...change } : n)) ?? prev);
  }, []);

  const markRead = (n: Notification) => {
    if (n.read_at) return;
    patchItem(n.id, { read_at: new Date().toISOString() });
    setCounts((c) => ({
      unread: Math.max(0, c.unread - 1),
      action_required: Math.max(0, c.action_required - (n.action_required && !n.done_at ? 1 : 0)),
    }));
    notificationsApi.patch(n.id, { read: true }).catch((err) => toast.error(messageOf(err)));
  };

  const openItem = (n: Notification) => {
    markRead(n);
    // An object that is gone stays listed as "No longer available"; there is nowhere to go.
    if (!n.available) return;
    setOpen(false);
    openLink(n.url);
  };

  const archive = (n: Notification) => {
    setItems((prev) => prev?.filter((x) => x.id !== n.id) ?? prev);
    if (!n.read_at) setCounts((c) => ({ ...c, unread: Math.max(0, c.unread - 1) }));
    notificationsApi.patch(n.id, { archived: true }).then(
      () => setTick((t) => t + 1),
      (err) => {
        toast.error(messageOf(err));
        setTick((t) => t + 1);
      },
    );
  };

  const act = (n: Notification, action: string) => {
    notificationsApi.act(n.id, action).then(
      (result) => {
        if (result.result === "redirect" && result.url) {
          markRead(n);
          setOpen(false);
          openLink(result.url);
          return;
        }
        patchItem(n.id, { done_at: new Date().toISOString(), read_at: n.read_at ?? "now" });
        setTick((t) => t + 1);
      },
      (err) => toast.error(messageOf(err)),
    );
  };

  const markAllRead = () => {
    notificationsApi.readAll().then(
      () => {
        setCounts((c) => ({ ...c, unread: 0 }));
        setTick((t) => t + 1);
      },
      (err) => toast.error(messageOf(err)),
    );
  };

  const list = items ?? [];
  const current = list[Math.min(selected, Math.max(0, list.length - 1))];
  const move = (by: number) =>
    setSelected((i) => Math.min(Math.max(0, list.length - 1), Math.max(0, i + by)));

  useHotkeys({
    n: () => setOpen(true),
    arrowdown: () => open && move(1),
    arrowup: () => open && move(-1),
    enter: () => open && current && openItem(current),
    e: () => open && current && archive(current),
    a: () => open && setTab((t) => (t === "all" ? "action_required" : "all")),
  });

  const unread = counts.unread;
  const label = unread > 0 ? `Notifications, ${unread} unread` : "Notifications";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="quiet" size="sm" className="relative justify-start" aria-label={label}>
          <Bell aria-hidden />
          Notifications
          {unread > 0 && (
            <span
              data-testid="unread-dot"
              aria-hidden
              className="ml-auto size-2 rounded-full bg-accent"
            />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="right"
        className="grid max-h-[80vh] w-[26rem] max-w-[calc(100vw-2rem)] gap-3 overflow-y-auto"
        aria-label="Notifications"
      >
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-section font-semibold">Notifications</h2>
          <Button variant="quiet" size="sm" onClick={markAllRead} disabled={unread === 0}>
            <Check aria-hidden />
            Mark all read
          </Button>
        </div>
        <div role="tablist" aria-label="Notification tabs" className="flex gap-4 border-b">
          {(
            [
              ["all", "All"],
              [
                "action_required",
                `Action required${counts.action_required > 0 ? ` (${counts.action_required})` : ""}`,
              ],
            ] as const
          ).map(([value, text]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
              className="-mb-px h-9 border-b-2 border-transparent px-1 text-ui font-medium text-fg-muted hover:text-fg aria-selected:border-accent aria-selected:text-fg"
            >
              {text}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <label className="grid flex-1 gap-1 text-caption text-fg-muted">
            Show
            <select
              className="h-8 rounded-md border border-control bg-bg-raised px-2 text-ui text-fg"
              value={state}
              onChange={(e) => setState(e.target.value as State)}
            >
              {STATES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label className="grid flex-1 gap-1 text-caption text-fg-muted">
            Category
            <select
              className="h-8 rounded-md border border-control bg-bg-raised px-2 text-ui text-fg"
              value={category}
              onChange={(e) => setCategory(e.target.value as NotificationCategory | "")}
            >
              <option value="">All categories</option>
              {(Object.keys(CATEGORY_LABELS) as NotificationCategory[]).map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </label>
        </div>
        {failed ? (
          <p role="alert" className="text-destructive">
            Couldn't load notifications. Try again.
          </p>
        ) : items === null ? (
          <p role="status" className="text-fg-muted">
            Loading notifications
          </p>
        ) : list.length === 0 ? (
          <p className="py-6 text-center text-fg-muted">
            {tab === "action_required" ? "Nothing needs your action." : "You're all caught up."}
          </p>
        ) : (
          <ul aria-label="Notifications" className="grid gap-1">
            {list.map((n, i) => (
              <NotificationRow
                key={n.id}
                n={n}
                selected={current?.id === n.id && i === Math.min(selected, list.length - 1)}
                onOpen={() => openItem(n)}
                onArchive={() => archive(n)}
                onAct={(action) => act(n, action)}
              />
            ))}
          </ul>
        )}
        {cursor && (
          <Button variant="secondary" size="sm" onClick={more}>
            Show more
          </Button>
        )}
        <p className="text-caption text-fg-muted">
          Keys: N opens, arrows move, Enter opens, E archives, A switches tab.
        </p>
      </PopoverContent>
    </Popover>
  );
}

function NotificationRow({
  n,
  selected,
  onOpen,
  onArchive,
  onAct,
}: {
  n: Notification;
  selected: boolean;
  onOpen: () => void;
  onArchive: () => void;
  onAct: (action: string) => void;
}) {
  const unread = !n.read_at;
  return (
    <li
      data-selected={selected || undefined}
      className="grid gap-1 rounded-md border border-border p-2 data-selected:tint-selected"
    >
      <div className="flex items-start gap-2">
        <span
          aria-hidden
          className={`mt-2 size-2 shrink-0 rounded-full ${unread ? "bg-accent" : "bg-transparent"}`}
        />
        <button
          type="button"
          onClick={onOpen}
          className="grid min-w-0 flex-1 gap-0.5 text-left"
          aria-label={`${unread ? "Unread: " : ""}${n.title}`}
        >
          <span className="text-ui font-medium">
            {n.title}
            {n.count > 1 && <span className="text-fg-muted"> ×{n.count}</span>}
          </span>
          {n.body && <span className="text-dense text-fg-muted">{n.body}</span>}
          <span className="text-caption text-fg-muted">
            {CATEGORY_LABELS[n.category]}
            {n.actor ? ` · ${n.actor.name}` : ""} · {formatDate(n.created_at)}
          </span>
        </button>
        {!n.archived_at && (
          <Button
            variant="quiet"
            size="icon"
            aria-label={`Archive: ${n.title}`}
            onClick={onArchive}
          >
            <Archive aria-hidden />
          </Button>
        )}
      </div>
      {!n.available ? (
        <p className="pl-4 text-dense text-fg-muted">No longer available</p>
      ) : n.done_at ? (
        <p className="pl-4 text-dense text-fg-muted">Done</p>
      ) : n.actions && n.actions.length > 0 ? (
        <div className="flex flex-wrap gap-2 pl-4">
          {n.actions.map((a) => (
            <Button
              key={a.id}
              size="sm"
              variant={
                a.style === "primary"
                  ? "primary"
                  : a.style === "danger"
                    ? "destructive"
                    : "secondary"
              }
              aria-label={`${a.label}: ${n.title}`}
              onClick={() => onAct(a.id)}
            >
              {a.label}
            </Button>
          ))}
        </div>
      ) : null}
    </li>
  );
}
