import { createActivities } from "@legallabs/runs";
import { describe, expect, it } from "vitest";
import { workflow } from "./catalogue/define.js";
import { createWorkflowHandler } from "./handler.js";
import { NOT_PROVIDED, SKIPPED } from "./render.js";
import {
  allowAll,
  memoryRun,
  runInMemory,
  scriptedModel,
  scriptedPorts,
  testFile,
} from "./testing.js";

const text = (id: string, label: string, extra = {}) => ({
  type: "user_input.text" as const,
  id,
  label,
  prompt: label,
  ...extra,
});
const ai = (id: string, label: string, prompt: string, extra = {}) => ({
  type: "ai_action" as const,
  id,
  label,
  prompt,
  ...extra,
});

const simple = workflow(
  [
    text("q", "Question"),
    text("note", "Note", { optional: true }),
    ai("a", "Answer", "Summarise @Question. Note: @Note"),
    { type: "response", id: "out", outputs: [{ ref: "@Answer", as: "message" }] },
  ],
  [
    ["q", "a"],
    ["note", "a"],
    ["a", "out"],
  ],
);

describe("a workflow run", () => {
  it("runs blocks as steps, fills references, posts outputs and adds up the cost", async () => {
    const ports = scriptedPorts({ definition: simple, inputs: { question: "Is it late?" } });
    const r = await runInMemory(ports.deps);
    expect(r.result).toEqual({ status: "done" });

    const steps = [...r.steps.values()].sort((a, b) => a.ordinal - b.ordinal);
    expect(steps.map((s) => [s.kind, s.block_id, s.label, s.status])).toEqual([
      ["block", "q", "Question", "done"],
      ["block", "note", "Note", "done"],
      ["block", "a", "Answer", "done"],
      ["block", "out", "Response", "done"],
    ]);
    // The text inline; an empty optional input reads as "(not provided)".
    expect(ports.model.calls[0]?.prompt).toBe(`Summarise Is it late?. Note: ${NOT_PROVIDED}`);
    expect(ports.model.calls[0]?.routing_class).toBe("summarise");

    const answer = steps[2];
    expect(answer?.model).toBe("scripted/summarise");
    expect(answer?.routing_class).toBe("summarise");
    expect(answer?.usage).toMatchObject({ input_tokens: 100, output_tokens: 20 });
    // AGT-008: the run's cost is the sum of its steps.
    const sum = steps.reduce((t, s) => t + s.cost_usd, 0);
    expect(Math.abs(r.run.cost_usd - sum)).toBeLessThan(0.0001);
    expect(r.run.cost_usd).toBeGreaterThan(0);

    expect(ports.artifacts.posted).toEqual([
      expect.objectContaining({ kind: "message", text: expect.stringContaining("Is it late?") }),
    ]);
    const outputs = r.events.filter((e) => e.type === "output");
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.data).toMatchObject({ kind: "message", title: "Answer" });
  });

  it("runs both selected branches, skips the third and renders it as (skipped)", async () => {
    const def = workflow(
      [
        {
          type: "user_input.select",
          id: "pick",
          label: "Pick",
          prompt: "Which?",
          multiple: true,
          options: [
            { id: "x", label: "X" },
            { id: "y", label: "Y" },
            { id: "z", label: "Z" },
          ],
        },
        {
          type: "logic.conditional",
          id: "cond",
          label: "Route",
          on: "@Pick",
          branches: [
            { option_ids: ["x"], to: "A" },
            { option_ids: ["y"], to: "B" },
            { option_ids: ["z"], to: "C" },
          ],
        },
        ai("A", "Branch A", "Draft A"),
        ai("B", "Branch B", "Draft B"),
        ai("C", "Branch C", "Draft C"),
        ai("C2", "After C", "Draft more from @Branch C"),
        ai("D", "Joined", "Combine @Branch A, @Branch B and @After C"),
        { type: "response", id: "out", outputs: [{ ref: "@Joined" }, { ref: "@After C" }] },
      ],
      [
        ["pick", "cond"],
        ["cond", "A"],
        ["cond", "B"],
        ["cond", "C"],
        ["C", "C2"],
        ["A", "D"],
        ["B", "D"],
        ["C2", "D"],
        ["D", "out"],
        ["C2", "out"],
      ],
    );
    const ports = scriptedPorts({ definition: def, inputs: { Pick: ["x", "y"] } });
    const r = await runInMemory(ports.deps);
    expect(r.result.status).toBe("done");
    const status = Object.fromEntries([...r.steps.values()].map((s) => [s.block_id, s.status]));
    expect(status).toMatchObject({ A: "done", B: "done", C: "skipped", C2: "skipped", D: "done" });
    const joined = ports.model.calls.find((c) => c.prompt.startsWith("Combine"));
    expect(joined?.prompt).toBe(
      `Combine draft answer to: Draft A, draft answer to: Draft B and ${SKIPPED}`,
    );
    // A skipped output posts nothing.
    expect(ports.artifacts.posted).toHaveLength(1);
  });

  it("takes the else branch when nothing matches", async () => {
    const def = workflow(
      [
        {
          type: "user_input.select",
          id: "pick",
          label: "Pick",
          prompt: "Which?",
          optional: true,
          default_option_ids: ["n"],
          options: [
            { id: "y", label: "Yes" },
            { id: "n", label: "No" },
          ],
        },
        {
          type: "logic.conditional",
          id: "cond",
          label: "Route",
          on: "@Pick",
          branches: [{ option_ids: ["y"], to: "A" }],
          else_to: "B",
        },
        ai("A", "Yes path", "Draft yes"),
        ai("B", "No path", "Draft no"),
        {
          type: "response",
          id: "out",
          outputs: [{ ref: "@Yes path" }, { ref: "@No path" }],
        },
      ],
      [
        ["pick", "cond"],
        ["cond", "A"],
        ["cond", "B"],
        ["A", "out"],
        ["B", "out"],
      ],
    );
    const r = await runInMemory(scriptedPorts({ definition: def, inputs: {} }).deps);
    const status = Object.fromEntries([...r.steps.values()].map((s) => [s.block_id, s.status]));
    expect(status).toMatchObject({ A: "skipped", B: "done" });
  });

  it("runs independent blocks together, never more than four at once", async () => {
    const ids = ["b1", "b2", "b3", "b4", "b5", "b6"];
    const def = workflow(
      [
        text("q", "Question"),
        ...ids.map((id) => ai(id, `Part ${id}`, `Analyse @Question part ${id}`)),
        { type: "response", id: "out", outputs: ids.map((id) => ({ ref: `@Part ${id}` })) },
      ],
      [
        ...ids.map((id): [string, string] => ["q", id]),
        ...ids.map((id): [string, string] => [id, "out"]),
      ],
    );
    const model = scriptedModel(undefined, { delayMs: 25 });
    const ports = scriptedPorts({ definition: def, inputs: { Question: "q" } }, { model });
    const r = await runInMemory(ports.deps);
    expect(r.result.status).toBe("done");
    expect(model.calls).toHaveLength(6);
    expect(model.maxInFlight()).toBe(4);
    expect(ports.artifacts.posted).toHaveLength(6);
  });

  it("an explicit model the policy refuses falls back to auto and says override_blocked", async () => {
    const def = workflow(
      [
        text("q", "Question"),
        ai("a", "Blocked", "Analyse @Question", { model: "provider-p/x" }),
        ai("b", "Allowed", "Analyse @Question again", { model: "provider-q/y" }),
        { type: "response", id: "out", outputs: [{ ref: "@Blocked" }, { ref: "@Allowed" }] },
      ],
      [
        ["q", "a"],
        ["q", "b"],
        ["a", "out"],
        ["b", "out"],
      ],
    );
    const ports = scriptedPorts(
      { definition: def, inputs: { Question: "q" } },
      { policy: allowAll({ blockedModels: ["provider-p/x"] }) },
    );
    const r = await runInMemory(ports.deps);
    expect(r.result.status).toBe("done");
    const step = (id: string) => [...r.steps.values()].find((s) => s.block_id === id);
    expect(step("a")?.routing_class).toBe("override_blocked");
    expect(step("a")?.model).toBe("scripted/reason");
    expect(step("b")?.routing_class).toBe("reason");
    expect(step("b")?.model).toBe("provider-q/y");
    expect(ports.model.calls.find((c) => c.prompt === "Analyse q")?.model).toBeUndefined();
  });

  it("fails before any step when no model may serve a class, naming the class only", async () => {
    const def = workflow(
      [
        text("q", "Question"),
        {
          type: "drafting",
          id: "d",
          label: "Letter",
          format: "docx",
          mode: "from_scratch",
          instructions: "Draft a letter on @Question",
        },
        { type: "response", id: "out", outputs: [{ ref: "@Letter", as: "file" }] },
      ],
      [
        ["q", "d"],
        ["d", "out"],
      ],
    );
    const ports = scriptedPorts(
      { definition: def, inputs: { Question: "q" } },
      { policy: allowAll({ noClasses: ["draft"] }) },
    );
    const r = await runInMemory(ports.deps);
    expect(r.result).toEqual({ status: "failed", code: "MODEL_POLICY_NO_ELIGIBLE_MODEL" });
    expect(r.steps.size).toBe(0);
    const error = r.events.find((e) => e.type === "error");
    expect(error?.data.message).toContain("draft");
    expect(error?.data.message).not.toContain("scripted");
  });

  it("records what drafting and table selection read, for the policy of later steps", async () => {
    const def = workflow(
      [
        { type: "user_input.file", id: "f", label: "Files", prompt: "Files" },
        { type: "user_input.review_table", id: "t", label: "Table", prompt: "Table" },
        { type: "review_table.select", id: "s", label: "Rows", table: "@Table" },
        {
          type: "drafting",
          id: "d",
          label: "Letter",
          format: "docx",
          mode: "from_scratch",
          instructions: "Draft from @Files",
        },
        { type: "response", id: "out", outputs: [{ ref: "@Letter", as: "file" }] },
      ],
      [
        ["f", "t"],
        ["t", "s"],
        ["s", "d"],
        ["d", "out"],
      ],
    );
    const tableId = "0194f3a0-0000-7000-8000-000000000001";
    const ports = scriptedPorts(
      { definition: def, inputs: { Files: [testFile("Lease.pdf")], Table: tableId } },
      { files: ["Lease.pdf"] },
    );
    ports.tables.port.select = async () => ({ table_id: tableId, columns: [], rows: [] });
    const r = await runInMemory(ports.deps);
    const read = (id: string) => [...r.steps.values()].find((s) => s.block_id === id)?.output.read;
    expect(read("s")).toEqual({ versions: [], tables: [tableId] });
    expect(read("d")).toEqual({
      versions: ports.drafts.calls[0]?.documents.map((d) => d.version_id),
      tables: [],
    });
    expect(ports.drafts.calls[0]?.documents).toHaveLength(1);
  });

  it("refuses bad inputs before any step", async () => {
    const r = await runInMemory(scriptedPorts({ definition: simple, inputs: {} }).deps);
    expect(r.result).toEqual({ status: "failed", code: "INPUT_INVALID" });
    expect(r.steps.size).toBe(0);
  });

  it("waits for approval when the plan reads more than 25 documents", async () => {
    const names = Array.from({ length: 26 }, (_, i) => `Doc ${i}.pdf`);
    const def = workflow(
      [
        { type: "user_input.file", id: "f", label: "Files", prompt: "Files" },
        ai("a", "Answer", "Summarise @Files"),
        { type: "response", id: "out", outputs: [{ ref: "@Answer" }] },
      ],
      [
        ["f", "a"],
        ["a", "out"],
      ],
    );
    const ports = scriptedPorts(
      { definition: def, inputs: { Files: names.map(testFile) } },
      { files: names },
    );
    const seen: string[] = [];
    const r = await runInMemory(ports.deps, {
      onWait: (status) => {
        seen.push(status);
        return { name: "approve_plan" };
      },
    });
    expect(seen[0]).toBe("awaiting_approval");
    expect(r.result.status).toBe("done");
    expect(ports.model.calls[0]?.documents).toHaveLength(26);
  });

  describe("a review table with a dry run", () => {
    const names = Array.from({ length: 12 }, (_, i) => `Lease ${i}.pdf`);
    const def = workflow(
      [
        { type: "user_input.file", id: "f", label: "Leases", prompt: "Leases" },
        {
          type: "review_table.generate",
          id: "t",
          label: "Terms",
          source: "@Leases",
          dry_run_rows: 10,
          columns: [{ label: "Rent", type: "currency", prompt: "The rent." }],
        },
        { type: "response", id: "out", outputs: [{ ref: "@Terms", as: "table" }] },
      ],
      [
        ["f", "t"],
        ["t", "out"],
      ],
    );
    const inputs = { Leases: names.map(testFile) };

    it("pauses for approval after the dry rows in an interactive run", async () => {
      const ports = scriptedPorts({ definition: def, inputs }, { files: names });
      const waits: { status: string; rows: unknown }[] = [];
      const r = await runInMemory(ports.deps, {
        onWait: (status, mem) => {
          const t = [...mem.steps.values()].find((s) => s.block_id === "t");
          waits.push({ status, rows: (t?.output.value as { rows_done?: number })?.rows_done });
          return { name: "approve_plan" };
        },
      });
      expect(waits).toEqual([{ status: "awaiting_approval", rows: 10 }]);
      expect(r.result.status).toBe("done");
      expect(ports.tables.calls).toEqual(["generate:10", "complete"]);
      const t = [...r.steps.values()].find((s) => s.block_id === "t");
      expect(t?.status).toBe("done");
      expect(t?.output.value).toMatchObject({ rows_done: 12, rows_total: 12 });
      // Dry rows and the rest are both charged, once.
      expect(t?.cost_usd).toBeCloseTo(12 * 0.0005, 6);
      expect(ports.artifacts.posted.map((p) => p.kind)).toEqual(["table"]);
    });

    it("keeps the dry rows when the person stops", async () => {
      const ports = scriptedPorts({ definition: def, inputs }, { files: names });
      const r = await runInMemory(ports.deps, {
        onWait: () => ({ name: "reject_plan", reason: "enough" }),
      });
      expect(r.result.status).toBe("done");
      expect(ports.tables.calls).toEqual(["generate:10"]);
    });

    it("continues without pausing in a scheduled run", async () => {
      const ports = scriptedPorts({ definition: def, inputs }, { files: names });
      const r = await runInMemory(ports.deps, { interactive: false });
      expect(r.result.status).toBe("done");
      expect(ports.tables.calls).toEqual(["generate:all"]);
      expect(r.events.some((e) => e.data.status === "awaiting_approval")).toBe(false);
    });
  });

  it("does not call the model twice when a step is retried after a crash", async () => {
    const ports = scriptedPorts({ definition: simple, inputs: { Question: "q" } });
    const mem = memoryRun();
    const finish = mem.store.finishStep;
    let crash = true;
    mem.store.finishStep = async (ordinal, result) => {
      // The worker dies after the model answered, before the step was marked done.
      if (ordinal === 2 && crash) {
        crash = false;
        throw new Error("worker lost");
      }
      return finish(ordinal, result);
    };
    const act = createActivities(
      {
        pool: {} as never,
        handlers: { workflow: createWorkflowHandler(ports.deps) },
        storeFor: () => mem.store,
      },
      {
        runId: mem.run.id,
        workspaceId: mem.run.workspace_id,
        userId: mem.run.owner_id,
        kind: "workflow",
        interactive: true,
        budget: { max_cost_usd: null, max_tokens: 5_000_000 },
      },
    );
    await act.begin();
    expect(await act.runStep(0)).toEqual({ kind: "continue" });
    expect(await act.runStep(1)).toEqual({ kind: "continue" });
    await expect(act.runStep(2)).rejects.toThrow("worker lost");
    // The activity is retried.
    expect(await act.runStep(2)).toEqual({ kind: "continue" });
    expect(await act.runStep(3)).toEqual({ kind: "done" });
    expect(ports.model.calls).toHaveLength(1);
    expect(mem.steps.get(2)?.cost_usd).toBeCloseTo(0.0012, 6);
    expect(mem.run.cost_usd).toBeCloseTo(0.0012, 6);
  });
});
