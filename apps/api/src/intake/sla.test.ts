import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { auditTrail, testPool } from "../test-db.js";
import { intakeDesk, type Person } from "../test-intake.js";

const pool = testPool();
afterAll(() => pool.end());
const desk = intakeDesk(pool);
beforeEach(() => {
  desk.model.answer = { type_id: null, confidence: 0, fields: {} };
  desk.provider.clear();
  desk.clock.at = null;
});

const NDA = { subject: "NDA with Acme", body: "Need an NDA with Acme." };
const HOUR = 3_600_000;
/** Moves the sweep's clock to this long after the request arrived. */
const later = (request: { created_at: string }, hours: number) => {
  desk.clock.at = new Date(new Date(request.created_at).getTime() + hours * HOUR + 1000);
};
const bell = async (id: string) =>
  (
    await pool.query(
      `select user_id from notify.notification
        where object_id = $1 and kind = 'intake.request_escalated'`,
      [id],
    )
  ).rows.map((r) => r.user_id);
const events = async (who: Person, id: string) =>
  (await desk.call(who, "GET", `/apps/intake/requests/${id}/audit`)).body.events as {
    kind: string;
    details: Record<string, unknown>;
  }[];

describe("the SLA sweep", () => {
  it("marks a request at risk, then breached, and escalates once", async () => {
    const d = await desk.open();
    const boss = await desk.member(d.admin, ["intake.triage"]);
    await d.type({
      fields: [],
      escalations: [
        { when: [{ sla: "breached" }], action: "notify", target: { user_id: boss.userId } },
      ],
    });
    await d.deliver(NDA);
    const request = await d.request();
    const state = async () =>
      (await pool.query("select sla_state from apps.intake_request where id = $1", [request.id]))
        .rows[0].sla_state;

    later(request, 6);
    await d.tick();
    expect(await state()).toBe("at_risk");
    expect(await bell(request.id)).toEqual([]);

    later(request, 8);
    await d.tick();
    later(request, 9);
    await d.tick();
    expect(await state()).toBe("breached");
    expect(await bell(request.id)).toEqual([boss.userId]);
    const audit = (await auditTrail(pool, d.admin.workspaceId)).map((a) => a.action);
    expect(audit.filter((a) => a === "intake.request.sla_breached")).toHaveLength(1);
    expect(audit.filter((a) => a === "intake.request.escalated")).toHaveLength(1);
  });

  it("reassigns on a structured condition, moving the task, and only to someone who can take it", async () => {
    const d = await desk.open();
    const gc = await desk.member(d.admin, ["intake.triage"]);
    const outsider = await desk.member(d.admin, ["threads.use"]);
    await pool.query(
      `insert into work.space_member (workspace_id, space_id, principal_type, principal_id, role, invited_by)
       values ($1, $2, 'user', $3, 'collaborator', $4)`,
      [d.admin.workspaceId, d.spaceId, gc.userId, d.admin.userId],
    );
    const value = [{ field: "value", op: "gt", value: 100000 }];
    await d.type({
      fields: [{ key: "value", label: "Value", type: "money", required: true }],
      escalations: [
        { when: value, action: "notify", target: { user_id: outsider.userId } },
        { when: value, action: "reassign", target: { user_id: gc.userId } },
        { when: value, action: "add_watcher", target: { user_id: d.lawyer.userId } },
      ],
    });
    desk.model.answer = { type_id: null, confidence: 1, fields: { value: 250000 } };
    await d.deliver(NDA);
    const request = await d.request();
    expect(request.assignee_id).toBe(gc.userId);
    const task = await pool.query("select assignee_id from work.task where id = $1", [
      request.task_id,
    ]);
    expect(task.rows[0].assignee_id).toBe(gc.userId);
    expect(await bell(request.id)).not.toContain(outsider.userId);
    const watchers = await pool.query(
      "select user_id from apps.intake_watcher where request_id = $1",
      [request.id],
    );
    expect(watchers.rows).toEqual([{ user_id: d.lawyer.userId }]);
  });
});

describe("a silent requester", () => {
  it("is reminded three times at most, then the request closes with a courtesy message", async () => {
    const d = await desk.open();
    await d.type();
    await d.deliver(NDA);
    const request = await d.request();
    expect(request.status).toBe("awaiting_requester");
    for (const hours of [19, 37, 55, 60]) {
      later(request, hours);
      await d.tick();
    }
    expect(desk.provider.sent.map((m) => m.subject.replace(/^\[.*\] /, ""))).toEqual([
      "We need one more detail",
      "We are still waiting for a detail",
      "We are still waiting for a detail",
      "We are still waiting for a detail",
    ]);
    later(request, 72);
    await d.tick();
    await d.tick();
    expect(await d.request()).toMatchObject({ status: "closed", closed_reason: "no_response" });
    expect(desk.provider.sent).toHaveLength(5);
    expect(desk.provider.sent.at(-1)?.text).toContain("has been closed");
  });

  it("is not closed while the question has not gone out", async () => {
    const d = await desk.open();
    await d.type();
    desk.provider.failNext(100);
    await d.deliver(NDA);
    later(await d.request(), 100);
    await d.tick();
    expect((await d.request()).status).toBe("awaiting_requester");
    desk.provider.failNext(0);
  });
});

describe("merging", () => {
  const two = async () => {
    const d = await desk.open();
    await d.type({ fields: [], routing: null });
    await d.deliver(NDA);
    await d.deliver(NDA);
    const [first, second] = await d.requests();
    return { d, first, second };
  };

  it("keeps the oldest, whichever way round, and tells the other thread", async () => {
    const { d, first, second } = await two();
    desk.provider.clear();
    const res = await desk.call(d.lawyer, "POST", `/apps/intake/requests/${first.id}/merge`, {
      into_request_id: second.id,
    });
    expect(res.status).toBe(200);
    expect(res.body.request.id).toBe(first.id);
    const [kept, merged] = await d.requests();
    expect(kept.status).toBe("triaged");
    expect(merged).toMatchObject({
      status: "closed",
      closed_reason: "merged",
      merged_into: first.id,
    });
    await d.tick();
    expect(desk.provider.sent.map((m) => m.text).join()).toContain("combined");
    expect(desk.provider.sent.map((m) => m.text).join()).not.toContain(`#${first.number}`);

    // An answer on the merged thread reaches the request that was kept.
    await d.answer("One more thing");
    expect(await d.requests()).toHaveLength(2);
    const kinds = (await events(d.admin, first.id)).map((e) => e.kind);
    expect(kinds.filter((k) => k === "inbound")).toHaveLength(2);
    expect(kinds).toContain("merged");
  });

  it("never joins requests of different matters, or one with itself", async () => {
    const { d, first, second } = await two();
    const matter = await pool.query(
      `insert into core.matter (workspace_id, client_id, client_name, matter_number, matter_name)
       values ($1, 'c', 'Client', 'm', 'M') returning id`,
      [d.admin.workspaceId],
    );
    await pool.query("update apps.intake_request set matter_id = $2 where id = $1", [
      second.id,
      matter.rows[0].id,
    ]);
    for (const into of [second.id, first.id, randomUUID()]) {
      const res = await desk.call(d.admin, "POST", `/apps/intake/requests/${first.id}/merge`, {
        into_request_id: into,
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
  });
});

describe("escalating by hand", () => {
  it("tells those who can take the request, and records the note outside the audit log", async () => {
    const d = await desk.open();
    await d.type({ fields: [] });
    await d.deliver(NDA);
    const { id } = await d.request();
    const boss = await desk.member(d.admin, ["intake.triage"]);
    const outsider = await desk.member(d.admin, ["threads.use"]);
    const escalate = (who: Person, userId: string) =>
      desk.call(who, "POST", `/apps/intake/requests/${id}/escalate`, {
        to: { user_id: userId },
        note: "Urgent for the board",
      });
    expect((await escalate(d.lawyer, outsider.userId)).body.code).toBe("ASSIGNEE_NOT_ALLOWED");
    expect((await escalate(outsider, boss.userId)).status).toBe(403);
    expect((await escalate(d.lawyer, boss.userId)).status).toBe(200);
    expect(await bell(id)).toEqual([boss.userId]);
    expect(await events(d.admin, id)).toContainEqual(
      expect.objectContaining({
        kind: "escalated",
        details: expect.objectContaining({ note: "Urgent for the board" }),
      }),
    );
    expect(JSON.stringify(await auditTrail(pool, d.admin.workspaceId))).not.toContain("board");
  });
});
