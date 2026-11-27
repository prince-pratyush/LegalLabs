import type { IntakeMine } from "@legallabs/contracts";
import { Skeleton } from "@legallabs/ui";
import { useEffect, useState } from "react";
import { messageOf } from "../api.js";
import { formatDate } from "../vaults/shared.js";
import { intakeApi } from "./api.js";
import { intakeHash } from "./route.js";

interface Item {
  id: string;
  name: string;
  href: string;
  due: string | null;
}

/** The caller's assigned requests and Space tasks together, soonest due first. */
function items(mine: IntakeMine): Item[] {
  // A request's own task would only list it twice.
  const covered = new Set(mine.requests.map((r) => r.task_id));
  return [
    ...mine.requests.map((r) => ({
      id: r.id,
      name: `Request #${r.number}${r.type_name ? `: ${r.type_name}` : ""}`,
      href: intakeHash({ page: "request", requestId: r.id }),
      due: r.sla?.due_at ?? null,
    })),
    ...mine.tasks
      .filter((t) => !covered.has(t.id))
      .map((t) => ({
        id: t.id,
        name: t.name,
        href: `#/spaces/${encodeURIComponent(t.space_id)}`,
        due: t.due_at,
      })),
  ].sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"));
}

export function MyTasksPage() {
  const [mine, setMine] = useState<IntakeMine | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    intakeApi.mine().then(setMine, (err) => setError(messageOf(err)));
  }, []);

  if (error) {
    return (
      <p role="alert" className="text-destructive">
        {error}
      </p>
    );
  }
  if (!mine) return <Skeleton className="h-16 max-w-xl" />;
  const list = items(mine);
  return (
    <div className="grid max-w-3xl content-start gap-4">
      <h1 className="text-title font-semibold">My tasks</h1>
      {list.length === 0 ? (
        <p className="text-fg-muted">Nothing is assigned to you.</p>
      ) : (
        <ul aria-label="My tasks" className="grid gap-2">
          {list.map((item) => (
            <li key={item.id} className="flex flex-wrap justify-between gap-2">
              <a className="underline" href={item.href}>
                {item.name}
              </a>
              <span className="text-fg-muted">
                {item.due ? `Due ${formatDate(item.due)}` : "No due date"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
