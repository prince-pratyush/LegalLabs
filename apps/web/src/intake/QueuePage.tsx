import {
  IntakeChannel,
  type IntakeRequest,
  IntakeStatus,
  type IntakeType,
} from "@legallabs/contracts";
import {
  Button,
  DataTable,
  EmptyState,
  Field,
  NativeSelect,
  type TableColumn,
} from "@legallabs/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, messageOf } from "../api.js";
import { latestOnly } from "../latest.js";
import { intakeApi, type QueueFilter } from "./api.js";
import { goIntake, intakeHash } from "./route.js";
import { age, CHANNEL, RequestStatusText, SlaText, STATUS } from "./shared.js";

const OPEN: QueueFilter = { status: "open", typeId: "", channel: "", assigneeId: "" };

// Requester text goes into cells as text children only: never as markup or as a link.
const columns: TableColumn<IntakeRequest>[] = [
  {
    id: "number",
    header: "#",
    sortValue: (r) => r.number,
    cell: (r) => (
      <a className="underline" href={intakeHash({ page: "request", requestId: r.id })}>
        #{r.number}
      </a>
    ),
  },
  {
    id: "type",
    header: "Type",
    sortValue: (r) => r.type_name?.toLowerCase() ?? "",
    cell: (r) => r.type_name ?? "No type",
  },
  {
    id: "requester",
    header: "Requester",
    sortValue: (r) => r.requester.display_name.toLowerCase(),
    cell: (r) => <span className="line-clamp-1">{r.requester.display_name}</span>,
  },
  {
    id: "channel",
    header: "Channel",
    sortValue: (r) => CHANNEL[r.channel],
    cell: (r) => CHANNEL[r.channel],
  },
  {
    id: "age",
    header: "Age",
    sortValue: (r) => r.created_at,
    cell: (r) => age(r.created_at),
  },
  {
    id: "sla",
    header: "SLA",
    sortValue: (r) => r.sla?.due_at ?? "",
    cell: (r) => (r.sla ? <SlaText state={r.sla.state} /> : "None"),
  },
  {
    id: "status",
    header: "Status",
    sortValue: (r) => STATUS[r.status].label,
    cell: (r) => <RequestStatusText status={r.status} />,
  },
  {
    id: "assignee",
    header: "Assignee",
    sortValue: (r) => r.assignee_name?.toLowerCase() ?? "",
    cell: (r) => r.assignee_name ?? "Unassigned",
  },
];

/** The requests waiting on triage, newest first. */
export function QueuePage() {
  const [filter, setFilter] = useState(OPEN);
  const [rows, setRows] = useState<IntakeRequest[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  const [types, setTypes] = useState<IntakeType[]>([]);
  const fetchPage = useRef(latestOnly(intakeApi.requests)).current;

  useEffect(() => {
    intakeApi.types().then(
      (t) => setTypes(t.types),
      () => undefined,
    );
  }, []);

  const load = useCallback(
    async (query: QueueFilter, after?: string) => {
      setError(null);
      try {
        const result = await fetchPage(query, after);
        if (!result.current) return;
        const { requests, next_cursor } = result.value;
        setRows((before) => (after ? [...(before ?? []), ...requests] : requests));
        setCursor(next_cursor);
      } catch (err) {
        setRows([]);
        setCursor(null);
        if (err instanceof ApiError && err.status === 403) setRefused(true);
        else setError(messageOf(err));
      }
    },
    [fetchPage],
  );

  useEffect(() => {
    setRows(null);
    load(filter);
  }, [filter, load]);

  if (refused) {
    return (
      <EmptyState
        title="You can't see the intake queue"
        description="It is for triage staff. Ask an administrator if you should be one."
        action={{ label: "See request types", onClick: () => goIntake({ page: "types" }) }}
      />
    );
  }

  const set = (key: keyof QueueFilter) => (e: { target: { value: string } }) =>
    setFilter((f) => ({ ...f, [key]: e.target.value }));
  const filtered = (Object.keys(OPEN) as (keyof QueueFilter)[]).some((k) => filter[k] !== OPEN[k]);

  return (
    <div className="grid content-start gap-4">
      <h1 className="text-title font-semibold">Triage queue</h1>
      <div className="flex flex-wrap gap-3">
        <Field label="Status">
          {(props) => (
            <NativeSelect {...props} value={filter.status} onChange={set("status")}>
              <option value="open">Open</option>
              <option value="">Any status</option>
              {IntakeStatus.options.map((status) => (
                <option key={status} value={status}>
                  {STATUS[status].label}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field label="Type">
          {(props) => (
            <NativeSelect {...props} value={filter.typeId} onChange={set("typeId")}>
              <option value="">Any type</option>
              {types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field label="Channel">
          {(props) => (
            <NativeSelect {...props} value={filter.channel} onChange={set("channel")}>
              <option value="">Any channel</option>
              {IntakeChannel.options.map((channel) => (
                <option key={channel} value={channel}>
                  {CHANNEL[channel]}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field label="Assignee">
          {(props) => (
            <NativeSelect {...props} value={filter.assigneeId} onChange={set("assigneeId")}>
              <option value="">Anyone</option>
              <option value="me">Me</option>
            </NativeSelect>
          )}
        </Field>
      </div>
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : (
        <DataTable
          label="Intake requests"
          columns={columns}
          rows={rows ?? []}
          getRowId={(r) => r.id}
          onActivate={(r) => goIntake({ page: "request", requestId: r.id })}
          loading={rows === null}
          empty={
            filtered ? (
              <EmptyState
                title="No requests match"
                description="Try fewer filters."
                action={{ label: "Clear filters", onClick: () => setFilter(OPEN) }}
              />
            ) : (
              <EmptyState
                title="No open requests"
                description="Requests show here when they arrive."
                action={{
                  label: "Set up request types",
                  onClick: () => goIntake({ page: "types" }),
                }}
              />
            )
          }
        />
      )}
      {cursor && (
        <div className="flex items-center gap-3">
          <Button variant="secondary" onClick={() => load(filter, cursor)}>
            Load more
          </Button>
          <span className="text-caption text-fg-muted">
            Sorting covers the requests loaded so far.
          </span>
        </div>
      )}
    </div>
  );
}
