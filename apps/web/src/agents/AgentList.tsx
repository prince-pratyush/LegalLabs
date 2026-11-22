import {
  type AgentRow,
  Button,
  Input,
  AgentList as List,
  PANEL_MIN,
  SidePanel,
} from "@legallabs/ui";
import { ChevronDown, FileUp, PenLine, Sparkles } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { type Agent, type AgentFilter, agentApi, agentError } from "./api.js";
import { ImportPanel } from "./ImportPanel.js";
import { goAgents } from "./route.js";

type Filter = "all" | "mine" | "shared" | "scheduled";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "mine", label: "Mine" },
  { value: "shared", label: "Shared with me" },
  { value: "scheduled", label: "Scheduled" },
];

export const toRow = (agent: Agent, me: string | null): AgentRow => ({
  id: agent.id,
  title: agent.title,
  description: agent.description,
  practiceAreas: agent.practice_areas,
  status: agent.status,
  access: agent.my_access,
  mine: agent.owner_id === me,
  runs: agent.stats.runs,
  schedule: agent.schedule
    ? { paused: agent.schedule.status === "paused", nextRunAt: agent.schedule.next_run_at }
    : null,
});

export function AgentList({ me }: { me: string | null }) {
  const menuId = useId();
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [area, setArea] = useState("");
  const [areas, setAreas] = useState<string[]>([]);
  const [rows, setRows] = useState<Agent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [importing, setImporting] = useState(false);
  const [creating, setCreating] = useState(false);

  // Practice areas come from everything visible, so the filter never offers an empty choice.
  useEffect(() => {
    agentApi.list().then(
      (all) => setAreas([...new Set(all.flatMap((a) => a.practice_areas))].sort()),
      () => undefined,
    );
  }, []);

  useEffect(() => {
    let live = true;
    const query: AgentFilter = {
      ...(filter === "mine" ? { owner: "me" as const } : {}),
      ...(filter === "shared" ? { owner: "shared" as const } : {}),
      ...(filter === "scheduled" ? { scheduled: true } : {}),
      ...(area ? { practiceArea: area } : {}),
      ...(q.trim() ? { q } : {}),
    };
    // A short pause, so typing a search doesn't send a request per key.
    const timer = setTimeout(() => {
      agentApi.list(query).then(
        (found) => {
          if (!live) return;
          setRows(found);
          setError(null);
        },
        (err) => live && setError(agentError(err)),
      );
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [filter, q, area]);

  const create = async (mode: "describe" | "scratch") => {
    setMenu(false);
    setCreating(true);
    setError(null);
    try {
      const agent = await agentApi.create(mode);
      goAgents(
        mode === "describe"
          ? { page: "build", agentId: agent.id }
          : { page: "agent", agentId: agent.id, tab: "instructions" },
      );
    } catch (err) {
      setError(agentError(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-1 gap-0">
      <div className="grid min-w-0 flex-1 content-start gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-title font-semibold">Agents</h1>
          <div className="relative">
            <Button
              aria-expanded={menu}
              aria-controls={menuId}
              disabled={creating}
              onClick={() => setMenu((m) => !m)}
            >
              Create agent
              <ChevronDown aria-hidden />
            </Button>
            {menu && (
              <ul
                id={menuId}
                aria-label="Create agent"
                className="absolute right-0 z-20 mt-1 grid w-64 gap-0.5 rounded-md border border-border bg-bg-raised p-1 shadow-lg"
                onKeyDown={(e) => {
                  if (e.key === "Escape") setMenu(false);
                }}
              >
                <li>
                  <MenuChoice
                    icon={Sparkles}
                    title="Describe"
                    detail="Say what it should do; it asks a few questions, then drafts."
                    onClick={() => create("describe")}
                  />
                </li>
                <li>
                  <MenuChoice
                    icon={FileUp}
                    title="Import"
                    detail="From a .md, .skill or .zip file."
                    onClick={() => {
                      setMenu(false);
                      setImporting(true);
                    }}
                  />
                </li>
                <li>
                  <MenuChoice
                    icon={PenLine}
                    title="From scratch"
                    detail="Write the instructions yourself."
                    onClick={() => create("scratch")}
                  />
                </li>
              </ul>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <fieldset className="flex flex-wrap gap-1">
            <legend className="sr-only">Show</legend>
            {FILTERS.map((f) => (
              <Button
                key={f.value}
                size="sm"
                variant={filter === f.value ? "secondary" : "quiet"}
                aria-pressed={filter === f.value}
                onClick={() => setFilter(f.value)}
              >
                {f.label}
              </Button>
            ))}
          </fieldset>
          <Input
            aria-label="Search agents"
            placeholder="Search by title or description"
            className="max-w-xs"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <select
            aria-label="Practice area"
            className="h-8 rounded-md border border-control bg-bg-raised px-2 text-ui text-fg"
            value={area}
            onChange={(e) => setArea(e.target.value)}
          >
            <option value="">All practice areas</option>
            {areas.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        <List
          rows={(rows ?? []).map((a) => toRow(a, me))}
          loading={rows === null && !error}
          filtered={filter !== "all" || Boolean(q.trim()) || Boolean(area)}
          onOpen={(row) => goAgents({ page: "agent", agentId: row.id, tab: "instructions" })}
          onCreate={() => setMenu(true)}
        />
      </div>
      {importing && (
        <SidePanel
          title="Import an agent"
          onClose={() => setImporting(false)}
          width={PANEL_MIN + 80}
        >
          <ImportPanel
            onCancel={() => setImporting(false)}
            onImported={(agent) =>
              goAgents({ page: "agent", agentId: agent.id, tab: "instructions" })
            }
          />
        </SidePanel>
      )}
    </div>
  );
}

function MenuChoice({
  icon: Icon,
  title,
  detail,
  onClick,
}: {
  icon: typeof Sparkles;
  title: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="grid w-full grid-cols-[auto_1fr] gap-x-2 rounded-sm px-2 py-1.5 text-left hover:tint-hover focus-visible:tint-selected"
    >
      <Icon aria-hidden className="row-span-2 mt-0.5 size-4 text-fg-muted" strokeWidth={1.5} />
      <span className="text-ui font-medium">{title}</span>
      <span className="text-caption text-fg-muted">{detail}</span>
    </button>
  );
}
