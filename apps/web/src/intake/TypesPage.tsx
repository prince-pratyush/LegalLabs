import type { IntakeType } from "@legallabs/contracts";
import { Button, EmptyState, Skeleton } from "@legallabs/ui";
import { useEffect, useState } from "react";
import { messageOf } from "../api.js";
import { intakeApi } from "./api.js";
import { goIntake, intakeHash } from "./route.js";

/** The workspace's request types; only managers can change them. */
export function TypesPage() {
  const [found, setFound] = useState<{ types: IntakeType[]; can_manage: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    intakeApi.types().then(setFound, (err) => setError(messageOf(err)));
  }, []);
  const create = () => goIntake({ page: "new-type" });

  return (
    <div className="grid max-w-2xl content-start gap-4">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-title font-semibold">Request types</h1>
        {found?.can_manage && found.types.length > 0 && (
          <Button onClick={create}>New request type</Button>
        )}
      </header>
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : !found ? (
        <Skeleton className="h-24" />
      ) : found.types.length === 0 ? (
        <EmptyState
          title="No request types yet"
          description="A type says what a request needs to include and how long it may take."
          action={
            found.can_manage
              ? { label: "New request type", onClick: create }
              : { label: "Back to the queue", onClick: () => goIntake({ page: "queue" }) }
          }
        />
      ) : (
        <ul className="grid divide-y divide-border rounded-md border border-border">
          {found.types.map((t) => (
            <li key={t.id} className="flex items-center gap-3 px-3 py-2">
              {found.can_manage ? (
                <a className="underline" href={intakeHash({ page: "type", typeId: t.id })}>
                  {t.name}
                </a>
              ) : (
                <span>{t.name}</span>
              )}
              <span className="ml-auto text-fg-muted">
                {t.fields.length} {t.fields.length === 1 ? "field" : "fields"} · {t.sla_hours} h
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
