import type { ApprovalConfig } from "@legallabs/contracts";
import {
  type AgentGrant,
  AgentShareForm,
  AgentShareFormSkeleton,
  type AgentShareRequest,
  blankSchedule,
  type PrincipalCandidate,
  ScheduleForm,
  type ScheduleValue,
  type ShareTarget,
  toSchedule,
} from "@legallabs/ui";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import { type Agent, agentApi, agentError, type Grant, type ScheduleView } from "./api.js";

const FALLBACK_ZONES = [
  "UTC",
  "Europe/London",
  "Europe/Paris",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
];

export const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

export function timeZones(): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
  try {
    const all = intl.supportedValuesOf?.("timeZone");
    if (all && all.length > 0) return all.includes("UTC") ? all : ["UTC", ...all];
  } catch {
    // Older engines have no list; the short one below still covers the common zones.
  }
  return FALLBACK_ZONES;
}

export const scheduleValue = (s: ScheduleView): ScheduleValue => ({
  rule: s.rule,
  n: s.params.n ?? 7,
  weekdays: s.params.weekdays ?? [1],
  timeLocal: s.time_local,
  tz: s.tz,
  matterId: s.matter_id ?? null,
  email: s.email,
  inputs: s.params.inputs ?? "",
  ...(s.anchor_date ? { anchorDate: s.anchor_date } : {}),
});

/** One schedule per person per agent; only a live agent can be scheduled. */
export function SchedulePanel({ agent, onChanged }: { agent: Agent; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [schedule, setSchedule] = useState<ScheduleView | null>(agent.schedule);

  if (agent.status !== "live") {
    return (
      <p className="text-dense text-fg-muted">
        Save the agent first: only the live version can run on a schedule.
      </p>
    );
  }

  const save = async (value: ScheduleValue) => {
    setBusy(true);
    setError(null);
    try {
      setSchedule(await agentApi.setSchedule(agent.id, toSchedule(value)));
      onChanged();
    } catch (err) {
      setError(agentError(err));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await agentApi.removeSchedule(agent.id);
      setSchedule(null);
      onChanged();
    } catch (err) {
      setError(agentError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScheduleForm
      key={schedule ? `${schedule.tz}-${schedule.time_local}` : "new"}
      initial={schedule ? scheduleValue(schedule) : blankSchedule(browserZone())}
      zones={timeZones()}
      state={
        schedule
          ? {
              paused: schedule.status === "paused",
              reason: schedule.paused_reason,
              nextRunAt: schedule.next_run_at,
            }
          : null
      }
      busy={busy}
      error={error}
      onSave={save}
      onRemove={remove}
    />
  );
}

const PENDING = "Pending approval: an admin will review this share before it takes effect.";

/** Who the agent is shared with; Full access only. */
export function SharePanel({ agent }: { agent: Agent }) {
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [requests, setRequests] = useState<AgentShareRequest[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [policy, setPolicy] = useState<ApprovalConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const label = useCallback(
    (type: string, id: string) =>
      type === "workspace"
        ? "Everyone in the workspace"
        : (names.get(id) ??
          (type === "group" ? "A group" : type === "space" ? "A Space" : "A person")),
    [names],
  );

  const load = useCallback(async () => {
    try {
      const r = await agentApi.shares(agent.id);
      setGrants(r.grants);
      setRequests(
        r.requests.map((q) => ({
          id: q.id,
          principalType: q.principal_type,
          label: q.principal_id,
          level: q.level,
          status: q.status,
          reason: q.reason,
        })),
      );
    } catch (err) {
      setGrants([]);
      setError(agentError(err));
    }
  }, [agent.id]);

  useEffect(() => {
    void load();
    api.members().then(
      (members) =>
        setNames((m) => new Map([...m, ...members.map((x) => [x.id, x.name || x.email] as const)])),
      () => undefined,
    );
    // Only admins may read the switches; anyone else simply isn't told the policy.
    agentApi.sharingConfig().then(setPolicy, () => setPolicy(null));
  }, [load]);

  const search = useCallback(async (q: string): Promise<PrincipalCandidate[]> => {
    const found = await agentApi.principals(q);
    setNames((m) => new Map([...m, ...found.map((p) => [p.principal_id, p.label] as const)]));
    return found.map((p) => ({
      principalType: p.principal_type,
      principalId: p.principal_id,
      label: p.label,
    }));
  }, []);

  const add = async (target: ShareTarget) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await agentApi.share(agent.id, {
        principal_type: target.principalType,
        ...(target.principalId ? { principal_id: target.principalId } : {}),
        level: target.level,
      });
      setNotice(r.outcome === "pending" ? PENDING : "Shared.");
      await load();
    } catch (err) {
      setError(agentError(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (grantId: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await agentApi.unshare(agent.id, grantId);
      await load();
    } catch (err) {
      setError(agentError(err));
    } finally {
      setBusy(false);
    }
  };

  if (grants === null) return <AgentShareFormSkeleton />;
  return (
    <AgentShareForm
      grants={grants.map(
        (g): AgentGrant => ({
          id: g.id,
          principalType: g.principal_type,
          label: label(g.principal_type, g.principal_id),
          level: g.level,
        }),
      )}
      requests={requests.map((r) => ({ ...r, label: label(r.principalType, r.label) }))}
      search={search}
      {...(policy ? { policy } : {})}
      busy={busy}
      error={error}
      notice={notice}
      onAdd={add}
      onRemove={remove}
    />
  );
}
