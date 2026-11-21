import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { type Handler, serve } from "../testing.js";
import type { Memory, WritingStyle } from "./api.js";
import { parseSettingsRoute, settingsHash } from "./route.js";
import { SettingsApp } from "./SettingsApp.js";

const at = (tab: string) => {
  window.location.hash = `#/settings/${tab}`;
};
const show = () => render(<SettingsApp onLeave={() => {}} />);
const last = (sent: { route: string; body: unknown }[], route: string) =>
  sent.filter((s) => s.route === route).at(-1)?.body;

describe("settings routes", () => {
  it("reads the tab from the address", () => {
    expect(parseSettingsRoute("#/settings")).toEqual({ tab: "notifications" });
    expect(parseSettingsRoute("#/settings/memory")).toEqual({ tab: "memory" });
    expect(parseSettingsRoute("#/settings/writing-styles?x=1")).toEqual({ tab: "writing-styles" });
    expect(parseSettingsRoute("#/settings/nonsense")).toEqual({ tab: "notifications" });
    expect(parseSettingsRoute("#/library")).toBeNull();
    expect(settingsHash("memory")).toBe("#/settings/memory");
  });
});

const category = (c: string, over: object = {}) => ({
  category: c,
  workspace_default: true,
  locked: false,
  effective: true,
  mode: "action_only",
  ...over,
});

describe("email notification settings", () => {
  const settings = {
    categories: [
      category("threads"),
      category("vault", { effective: false, user_value: false }),
      category("admin", { locked: true, effective: false, workspace_default: false }),
    ],
    include_content: false,
  };

  it("toggles a category and shows a locked one disabled with its reason", async () => {
    at("notifications");
    const sent = serve({
      "GET /api/v1/notification-settings": () => [200, settings],
      "PATCH /api/v1/notification-settings": () => [
        200,
        {
          ...settings,
          categories: [category("threads", { effective: false }), ...settings.categories.slice(1)],
        },
      ],
    });
    show();
    const threads = await screen.findByRole("checkbox", { name: "Email for Threads" });
    expect(threads.getAttribute("aria-checked")).toBe("true");
    const locked = screen.getByRole("checkbox", { name: "Email for Admin" });
    expect((locked as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Set by your workspace admin/)).toBeTruthy();
    expect(screen.getByText(/titles and links/)).toBeTruthy();

    fireEvent.click(threads);
    await waitFor(() =>
      expect(
        screen.getByRole("checkbox", { name: "Email for Threads" }).getAttribute("aria-checked"),
      ).toBe("false"),
    );
    expect(last(sent, "PATCH /api/v1/notification-settings")).toEqual({
      categories: [{ category: "threads", value: false }],
    });
  });

  it("changes the mode of a category", async () => {
    at("notifications");
    const sent = serve({
      "GET /api/v1/notification-settings": () => [200, settings],
      "PATCH /api/v1/notification-settings": () => [200, settings],
    });
    show();
    const mode = await screen.findByLabelText("Email mode for Threads");
    fireEvent.change(mode, { target: { value: "all" } });
    await waitFor(() =>
      expect(last(sent, "PATCH /api/v1/notification-settings")).toEqual({
        categories: [{ category: "threads", value: true, mode: "all" }],
      }),
    );
  });

  it("saves quiet hours, and clears them", async () => {
    at("notifications");
    const sent = serve({
      "GET /api/v1/notification-settings": () => [
        200,
        { ...settings, quiet_hours: { from: "21:00", to: "06:30", tz: "Australia/Sydney" } },
      ],
      "PATCH /api/v1/notification-settings": () => [200, settings],
    });
    show();
    const from = await screen.findByLabelText("From");
    expect((from as HTMLInputElement).value).toBe("21:00");
    fireEvent.change(from, { target: { value: "22:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save quiet hours" }));
    await waitFor(() =>
      expect(last(sent, "PATCH /api/v1/notification-settings")).toEqual({
        quiet_hours: { from: "22:00", to: "06:30", tz: "Australia/Sydney" },
      }),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Use quiet hours" }));
    fireEvent.click(screen.getByRole("button", { name: "Save quiet hours" }));
    await waitFor(() =>
      expect(last(sent, "PATCH /api/v1/notification-settings")).toEqual({ quiet_hours: null }),
    );
  });
});

const mem = (id: string, text: string, over: Partial<Memory> = {}): Memory => ({
  id,
  text,
  source: "manual",
  created_at: "2026-11-10T00:00:00.000Z",
  updated_at: "2026-11-10T00:00:00.000Z",
  ...over,
});

function memoryRoutes(
  items: Memory[],
  extra: Record<string, Handler> = {},
): Record<string, Handler> {
  return {
    "GET /api/v1/memory/settings": () => [
      200,
      { use_memory: true, permitted: true, pending_candidates: 0 },
    ],
    "GET /api/v1/memory": () => [200, { items, count: items.length, limit: 1000, enabled: true }],
    "GET /api/v1/memory/candidates": () => [200, { items: [] }],
    ...extra,
  };
}

describe("memory settings", () => {
  it("says so when the role lacks memory", async () => {
    at("memory");
    serve({
      "GET /api/v1/memory/settings": () => [403, { code: "NOT_ENABLED", message: "Not enabled." }],
    });
    show();
    expect(await screen.findByText("Not enabled for your role")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add memory" })).toBeNull();
  });

  it("lists, creates, edits and deletes memories", async () => {
    at("memory");
    const items = [mem("m1", "I prefer British spelling.")];
    const sent = serve(
      memoryRoutes(items, {
        "POST /api/v1/memory": () => [201, mem("m2", "Cite the case first.")],
        "PATCH /api/v1/memory/m1": () => [200, mem("m1", "I prefer Australian spelling.")],
        "DELETE /api/v1/memory/m1": () => [204, null],
      }),
    );
    show();
    const list = await screen.findByRole("list", { name: "Memories" });
    expect(within(list).getByText("I prefer British spelling.")).toBeTruthy();
    expect(screen.getByText("1 of 1000 memories used.")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("New memory"), {
      target: { value: "  Cite the case first. " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add memory" }));
    await waitFor(() =>
      expect(last(sent, "POST /api/v1/memory")).toEqual({ text: "Cite the case first." }),
    );

    fireEvent.click(within(list).getByRole("button", { name: "Edit: I prefer British spelling." }));
    fireEvent.change(within(list).getByLabelText("Memory text"), {
      target: { value: "I prefer Australian spelling." },
    });
    fireEvent.click(within(list).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(last(sent, "PATCH /api/v1/memory/m1")).toEqual({
        text: "I prefer Australian spelling.",
      }),
    );

    fireEvent.click(
      await within(list).findByRole("button", { name: "Delete: I prefer British spelling." }),
    );
    await waitFor(() =>
      expect(sent.some((s) => s.route === "DELETE /api/v1/memory/m1")).toBe(true),
    );
  });

  it("shows the server's words when the limit is hit", async () => {
    at("memory");
    serve(
      memoryRoutes([], {
        "POST /api/v1/memory": () => [
          422,
          {
            code: "LIMIT_MEMORIES",
            message: "You have 1,000 memories. Delete or merge some first.",
          },
        ],
      }),
    );
    show();
    fireEvent.change(await screen.findByLabelText("New memory"), { target: { value: "One more" } });
    fireEvent.click(screen.getByRole("button", { name: "Add memory" }));
    expect(await screen.findByText(/Delete or merge some first/)).toBeTruthy();
  });

  it("flags a conflict and offers Resolve", async () => {
    at("memory");
    serve(
      memoryRoutes([
        mem("m1", "Use UK spelling.", { conflicts_with: ["m2"] }),
        mem("m2", "Use US spelling.", { conflicts_with: ["m1"] }),
      ]),
    );
    show();
    expect((await screen.findAllByText("Conflicts with another memory")).length).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: "Resolve: Use UK spelling." }));
    expect(screen.getByLabelText("Memory text")).toBeTruthy();
  });

  it("turns memory use off", async () => {
    at("memory");
    const sent = serve(
      memoryRoutes([], {
        "PATCH /api/v1/memory/settings": () => [
          200,
          { use_memory: false, permitted: true, pending_candidates: 0 },
        ],
      }),
    );
    show();
    const toggle = await screen.findByRole("checkbox", { name: "Use memory in responses" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(last(sent, "PATCH /api/v1/memory/settings")).toEqual({ use_memory: false }),
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole("checkbox", { name: "Use memory in responses" })
          .getAttribute("aria-checked"),
      ).toBe("false"),
    );
  });

  it("deletes everything only after confirmation, with the confirm header", async () => {
    at("memory");
    const sent = serve(
      memoryRoutes([mem("m1", "A")], { "DELETE /api/v1/memory": () => [204, null] }),
    );
    show();
    await screen.findByRole("list", { name: "Memories" });
    fireEvent.click(screen.getByRole("button", { name: "Delete all" }));
    expect(sent.some((s) => s.route === "DELETE /api/v1/memory")).toBe(false);
    fireEvent.click(await screen.findByRole("button", { name: "Delete all memories" }));
    await waitFor(() => expect(sent.some((s) => s.route === "DELETE /api/v1/memory")).toBe(true));
  });

  it("saves or dismisses suggested memories", async () => {
    at("memory");
    const sent = serve({
      ...memoryRoutes([]),
      "GET /api/v1/memory/candidates": () => [
        200,
        {
          items: [
            {
              id: "c1",
              text: "Address opposing counsel formally.",
              from_message_id: null,
              created_at: "x",
              expires_at: "y",
            },
            {
              id: "c2",
              text: "Skip headings.",
              from_message_id: null,
              created_at: "x",
              expires_at: "y",
            },
          ],
        },
      ],
      "POST /api/v1/memory/candidates/c1/accept": () => [
        200,
        mem("m9", "Address opposing counsel formally."),
      ],
      "POST /api/v1/memory/candidates/c2/dismiss": () => [204, null],
    });
    show();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Save as memory: Address opposing counsel formally.",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss: Skip headings." }));
    await waitFor(() => {
      expect(sent.some((s) => s.route === "POST /api/v1/memory/candidates/c1/accept")).toBe(true);
      expect(sent.some((s) => s.route === "POST /api/v1/memory/candidates/c2/dismiss")).toBe(true);
    });
  });

  it("personalises: six questions, then proposals are confirmed before saving", async () => {
    at("memory");
    const sent = serve(
      memoryRoutes([], {
        "POST /api/v1/memory/personalise": () => [
          200,
          { proposals: [{ text: "I am a litigation associate." }, { text: "I work in NSW." }] },
        ],
        "POST /api/v1/memory": () => [201, mem("m1", "x")],
      }),
    );
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Start personalising" }));
    for (const label of [
      "What is your role?",
      "Which practice areas do you work in?",
      "Which jurisdictions do you work in?",
      "How do you like your writing to read?",
      "How should citations be handled?",
      "What output format do you prefer?",
    ]) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
    fireEvent.change(screen.getByLabelText("What is your role?"), {
      target: { value: "Litigation associate" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Suggest memories" }));
    await screen.findByRole("list", { name: "Proposed memories" });
    expect(sent.some((s) => s.route === "POST /api/v1/memory")).toBe(false);
    fireEvent.click(screen.getByRole("checkbox", { name: "Keep: I work in NSW." }));
    fireEvent.click(screen.getByRole("button", { name: "Save selected memories" }));
    await waitFor(() =>
      expect(sent.filter((s) => s.route === "POST /api/v1/memory")).toHaveLength(1),
    );
    expect(last(sent, "POST /api/v1/memory")).toEqual({ text: "I am a litigation associate." });
  });

  it("imports a CSV through a review table with Keep and Skip", async () => {
    at("memory");
    const sent = serve(
      memoryRoutes([], {
        "POST /api/v1/memory/import/parse": () => [
          200,
          {
            import_id: "imp1",
            would_exceed_cap: 3,
            rows: [
              { line: 2, text: "Use plain English.", status: "ok" },
              { line: 3, text: "Prefer tables.", status: "ok" },
              { line: 4, text: "Already here.", status: "duplicate" },
              { line: 5, text: "", status: "error", error: "text is required" },
            ],
          },
        ],
        "POST /api/v1/memory/import/imp1/commit": () => [200, { created: 1, skipped: 2 }],
      }),
    );
    show();
    expect(await screen.findByText(/List every memory you hold about me as CSV/)).toBeTruthy();
    const file = new File(["text\nUse plain English."], "memories.csv", { type: "text/csv" });
    fireEvent.change(screen.getByLabelText("CSV file"), { target: { files: [file] } });
    const table = await screen.findByRole("table", { name: "Memories found in the file" });
    expect(screen.getByRole("alert").textContent).toMatch(/3 over your memory limit/);
    expect(within(table).getByText("Already saved")).toBeTruthy();
    expect(within(table).getByText("Error: text is required")).toBeTruthy();
    expect(
      (within(table).getByRole("checkbox", { name: "Keep line 4" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.click(within(table).getByRole("checkbox", { name: "Keep line 3" }));
    fireEvent.change(within(table).getByLabelText("Text for line 2"), {
      target: { value: "Use very plain English." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import selected (1)" }));
    await waitFor(() =>
      expect(last(sent, "POST /api/v1/memory/import/imp1/commit")).toEqual({
        rows: [{ line: 2, text: "Use very plain English." }],
      }),
    );
    await waitFor(() => expect(screen.queryByRole("table")).toBeNull());
  });

  it("offers an export download", async () => {
    at("memory");
    serve(memoryRoutes([]));
    show();
    const link = await screen.findByRole("link", { name: "Export memories" });
    expect(link.getAttribute("href")).toBe("/api/v1/memory/export");
  });
});

const style = (id: string, over: Partial<WritingStyle> = {}): WritingStyle => ({
  id,
  name: `Style ${id}`,
  owner_id: "u1",
  owner_name: "Ana Silva",
  kind: "instructions",
  instructions: "Short sentences.",
  derived_instructions: null,
  sample: null,
  shared: false,
  status: "ready",
  editable: true,
  updated_at: "2026-11-10T00:00:00.000Z",
  ...over,
});

describe("writing styles", () => {
  it("creates one from instructions", async () => {
    at("writing-styles");
    const sent = serve({
      "GET /api/v1/writing-styles": () => [200, { mine: [], workspace: [] }],
      "POST /api/v1/writing-styles": () => [201, style("s1")],
    });
    show();
    fireEvent.change(await screen.findByLabelText("Style name"), { target: { value: "Plain" } });
    fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "No Latin." } });
    fireEvent.click(screen.getByRole("button", { name: "Create style" }));
    await waitFor(() =>
      expect(last(sent, "POST /api/v1/writing-styles")).toEqual({
        name: "Plain",
        instructions: "No Latin.",
      }),
    );
  });

  it("creates one from a sample file and shows the server's error for a long sample", async () => {
    at("writing-styles");
    serve({
      "GET /api/v1/writing-styles": () => [200, { mine: [], workspace: [] }],
      "POST /api/v1/writing-styles": () => [
        400,
        { code: "LIMIT_STYLE_SAMPLE", message: "That sample is over 20 pages." },
      ],
    });
    show();
    fireEvent.change(await screen.findByLabelText("Style name"), { target: { value: "Firm" } });
    fireEvent.click(screen.getByLabelText("Learn from a sample file"));
    const file = new File(["x"], "memo.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText("Sample file"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Create style" }));
    expect((await screen.findByRole("alert")).textContent).toBe("That sample is over 20 pages.");
  });

  it("shows and edits the derived instructions of a sample style", async () => {
    at("writing-styles");
    const sent = serve({
      "GET /api/v1/writing-styles": () => [
        200,
        {
          mine: [
            style("s1", {
              name: "From memo",
              kind: "sample",
              instructions: null,
              derived_instructions: "Formal, numbered headings.",
              sample: { pages: 3, chars: 9000 },
            }),
          ],
          workspace: [],
        },
      ],
      "PATCH /api/v1/writing-styles/s1": () => [200, style("s1")],
    });
    show();
    expect(await screen.findByText("Formal, numbered headings.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit: From memo" }));
    fireEvent.change(screen.getByLabelText("Instructions for From memo"), {
      target: { value: "Formal, bullets." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(last(sent, "PATCH /api/v1/writing-styles/s1")).toEqual({
        derived_instructions: "Formal, bullets.",
      }),
    );
  });

  it("shares with the workspace, and explains a 403", async () => {
    at("writing-styles");
    const sent = serve({
      "GET /api/v1/writing-styles": () => [
        200,
        { mine: [style("s1", { name: "Mine" })], workspace: [] },
      ],
      "POST /api/v1/writing-styles/s1/share": () => [
        403,
        {
          code: "SHARE_FORBIDDEN",
          message:
            "Sharing writing styles with the workspace needs the writing_styles.share permission.",
        },
      ],
    });
    show();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Share Mine with the workspace" }));
    await waitFor(() =>
      expect(last(sent, "POST /api/v1/writing-styles/s1/share")).toEqual({ shared: true }),
    );
    expect(await screen.findByText(/needs the writing_styles.share permission/)).toBeTruthy();
    expect(
      screen
        .getByRole("checkbox", { name: "Share Mine with the workspace" })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("lists workspace styles read only", async () => {
    at("writing-styles");
    serve({
      "GET /api/v1/writing-styles": () => [
        200,
        {
          mine: [],
          workspace: [
            style("w1", {
              name: "House style",
              owner_name: "Dee Admin",
              shared: true,
              editable: false,
            }),
          ],
        },
      ],
    });
    show();
    const list = await screen.findByRole("list", { name: "Workspace writing styles" });
    expect(within(list).getByText("House style")).toBeTruthy();
    expect(within(list).getByText(/Shared by Dee Admin; read only/)).toBeTruthy();
    expect(within(list).queryByRole("button")).toBeNull();
  });
});
