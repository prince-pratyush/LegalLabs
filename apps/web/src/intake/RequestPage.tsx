import {
  INTAKE_LIMITS,
  type IntakeEvent,
  type IntakeRequestDetail,
  IntakeStatus,
  type IntakeStatusChange,
  type IntakeType,
  intakeIsOpen,
  intakeNextStatuses,
} from "@legallabs/contracts";
import { Button, EmptyState, Field, Input, NativeSelect, Skeleton } from "@legallabs/ui";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { ApiError, messageOf } from "../api.js";
import { formatDate } from "../vaults/shared.js";
import { intakeApi } from "./api.js";
import { goIntake } from "./route.js";
import { CHANNEL, RequestStatusText, SlaText, STATUS } from "./shared.js";

const MOVES: Record<Exclude<IntakeStatusChange["status"], "closed">, string> = {
  awaiting_requester: "Wait for requester",
  triaged: "Mark triaged",
  in_progress: "Start work",
  waiting_approval: "Send for approval",
  done: "Mark done",
};

const statusLabel = (value: unknown) => {
  const parsed = IntakeStatus.safeParse(value);
  return parsed.success ? STATUS[parsed.data].label : "Unknown";
};

function happened(event: IntakeEvent, types: IntakeType[]): string {
  const { details } = event;
  switch (event.kind) {
    case "inbound":
      return "Received";
    case "classified": {
      const type = types.find((t) => t.id === details.type_id);
      return type ? `Type set to ${type.name}` : "Type set";
    }
    case "assigned":
      return details.assignee_id ? "Assigned" : "Unassigned";
    case "status":
      return `Status changed from ${statusLabel(details.from)} to ${statusLabel(details.to)}`;
    case "outbound":
      return "Message sent";
    case "routed":
      return "Routed";
    case "escalated":
      return "Escalated";
    case "sla":
      return "SLA state changed";
    case "merged":
      return "Merged";
  }
}

const at = (iso: string) =>
  `${formatDate(iso)}, ${new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  })}`;

/**
 * One request: what was asked, who has it and everything that happened. Whatever a requester
 * sent is rendered as text children, never as markup and never as a link.
 */
export function RequestPage({ requestId }: { requestId: string }) {
  const [request, setRequest] = useState<IntakeRequestDetail | null>(null);
  const [events, setEvents] = useState<IntakeEvent[]>([]);
  const [types, setTypes] = useState<IntakeType[]>([]);
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState<string | null>(null);

  const history = useCallback(
    () => intakeApi.events(requestId).then(setEvents, (err) => setError(messageOf(err))),
    [requestId],
  );

  useEffect(() => {
    intakeApi.request(requestId).then(
      (found) => {
        setRequest(found);
        history();
        intakeApi.assignees(requestId).then(setPeople, (err) => setError(messageOf(err)));
      },
      (err) => {
        if (err instanceof ApiError && err.status === 404) setMissing(true);
        else setError(messageOf(err));
      },
    );
    intakeApi.types().then(
      (t) => setTypes(t.types),
      () => undefined,
    );
  }, [requestId, history]);

  const act = async (work: () => Promise<IntakeRequestDetail>) => {
    setBusy(true);
    setError(null);
    try {
      setRequest(await work());
      setReason(null);
      await history();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  if (missing) {
    return (
      <EmptyState
        title="Request not found"
        description="It may not exist, or you may not have access to it."
        action={{ label: "Back to the queue", onClick: () => goIntake({ page: "queue" }) }}
      />
    );
  }
  if (!request) {
    return error ? (
      <p role="alert" className="text-destructive">
        {error}
      </p>
    ) : (
      <div aria-busy="true" className="grid max-w-xl gap-2">
        <Skeleton className="h-6" />
        <Skeleton className="h-16" />
      </div>
    );
  }

  const open = intakeIsOpen(request.status);
  const type = types.find((t) => t.id === request.type_id);
  const label = (key: string) => type?.fields.find((f) => f.key === key)?.label ?? key;
  const fields = Object.entries(request.fields);
  const next = intakeNextStatuses(request.status);
  const shown = (value: string | number | boolean) => {
    if (typeof value === "boolean") return value ? "Yes" : "No";
    // A file field holds the attachment's id.
    return request.attachments.find((f) => f.document_id === value)?.name ?? String(value);
  };

  const close = (e: FormEvent) => {
    e.preventDefault();
    const why = reason?.trim();
    if (why) act(() => intakeApi.setStatus(request.id, { status: "closed", reason: why }));
  };

  return (
    <div className="grid max-w-3xl content-start gap-4">
      <h1 className="text-title font-semibold">Request #{request.number}</h1>

      <section aria-label="Triage" className="grid gap-3 rounded-md border border-border p-3">
        <div className="flex flex-wrap items-center gap-3">
          <RequestStatusText status={request.status} />
          {request.sla && <SlaText state={request.sla.state} />}
          <span className="text-fg-muted">
            {request.sla ? `Due ${at(request.sla.due_at)}` : "No due time"}
          </span>
          <span className="text-fg-muted">
            {request.assignee_name ? `Assigned to ${request.assignee_name}` : "Unassigned"}
          </span>
        </div>
        {request.closed_reason && <p>Closed: {request.closed_reason}</p>}
        {open && (
          <>
            <div className="flex flex-wrap gap-3">
              <Field label="Request type">
                {(props) => (
                  <NativeSelect
                    {...props}
                    value={request.type_id ?? ""}
                    disabled={busy}
                    onChange={(e) => {
                      const typeId = e.target.value;
                      if (typeId) act(() => intakeApi.setType(request.id, typeId));
                    }}
                  >
                    <option value="">No type</option>
                    {/* A removed type still names the requests made against it. */}
                    {request.type_id && !type && (
                      <option value={request.type_id}>{request.type_name}</option>
                    )}
                    {types.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
              <Field label="Assignee">
                {(props) => (
                  <NativeSelect
                    {...props}
                    value={request.assignee_id ?? ""}
                    disabled={busy}
                    onChange={(e) => {
                      const person = e.target.value || null;
                      act(() => intakeApi.assign(request.id, person));
                    }}
                  >
                    <option value="">Unassigned</option>
                    {request.assignee_id && !people.some((p) => p.id === request.assignee_id) && (
                      <option value={request.assignee_id}>{request.assignee_name}</option>
                    )}
                    {people.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
            </div>
            <div className="flex flex-wrap gap-2">
              {next.map((status) =>
                status === "closed" || status === "new" || status === "unclassified" ? null : (
                  <Button
                    key={status}
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => act(() => intakeApi.setStatus(request.id, { status }))}
                  >
                    {MOVES[status]}
                  </Button>
                ),
              )}
              <Button
                variant="quiet"
                size="sm"
                aria-expanded={reason !== null}
                onClick={() => setReason((r) => (r === null ? "" : null))}
              >
                Close…
              </Button>
            </div>
            {reason !== null && (
              <form className="flex flex-wrap items-end gap-2" onSubmit={close}>
                <Field label="Why is it being closed?" className="min-w-60 flex-1">
                  {(props) => (
                    <Input
                      {...props}
                      value={reason}
                      maxLength={INTAKE_LIMITS.reason_chars}
                      onChange={(e) => setReason(e.target.value)}
                    />
                  )}
                </Field>
                <Button type="submit" size="sm" disabled={busy || !reason.trim()}>
                  Close request
                </Button>
              </form>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
      </section>

      <section aria-labelledby="intake-asked" className="grid gap-2">
        <h2 id="intake-asked" className="text-section font-semibold">
          What was asked
        </h2>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 break-words">
          <dt className="text-fg-muted">Requester</dt>
          <dd>{request.requester.display_name}</dd>
          {request.requester.email && (
            <>
              <dt className="text-fg-muted">Email</dt>
              <dd>{request.requester.email}</dd>
            </>
          )}
          <dt className="text-fg-muted">Channel</dt>
          <dd>{CHANNEL[request.channel]}</dd>
          {fields.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="text-fg-muted">{label(key)}</dt>
              <dd className="whitespace-pre-wrap">{shown(value)}</dd>
            </div>
          ))}
        </dl>
        {request.missing_fields.length > 0 && (
          <p className="text-fg-muted">
            Still missing: {request.missing_fields.map(label).join(", ")}
          </p>
        )}
      </section>

      {request.attachments.length > 0 && (
        <section aria-labelledby="intake-files" className="grid gap-2">
          <h2 id="intake-files" className="text-section font-semibold">
            Files
          </h2>
          <ul className="grid gap-1">
            {request.attachments.map((file) => (
              <li key={file.document_id} className="flex flex-wrap gap-3">
                {file.state === "indexed" ? (
                  <a className="underline" href={`/d/${encodeURIComponent(file.document_id)}/v/1`}>
                    {file.name}
                  </a>
                ) : (
                  <>
                    <span>{file.name}</span>
                    <span className="text-fg-muted">
                      {file.state === "failed" ? "Couldn't be read" : "Being checked"}
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="intake-timeline" className="grid gap-2">
        <h2 id="intake-timeline" className="text-section font-semibold">
          Timeline
        </h2>
        <ol aria-labelledby="intake-timeline" className="grid gap-1">
          {events.map((event) => (
            <li key={event.id} className="flex flex-wrap gap-x-3">
              <span>{happened(event, types)}</span>
              <span className="text-fg-muted">
                {event.actor_name ?? "System"} · {at(event.at)}
              </span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
