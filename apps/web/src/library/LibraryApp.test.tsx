import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prompt, Template } from "./api.js";
import { LibraryApp } from "./LibraryApp.js";
import { sendToComposer, takeComposerPrefill } from "./prefill.js";
import { libraryHash, parseLibraryRoute } from "./route.js";

const PROMPT: Prompt = {
  id: "0190a000-0000-7000-8000-000000000001",
  name: "NDA first pass",
  description: "One-sided terms",
  text: "Review the NDA for {{counterparty}}.",
  variables: ["counterparty"],
  owner: { id: "u1", name: "Ana Silva" },
  access: "owner",
  shared: false,
  updated_at: "2026-11-10T00:00:00.000Z",
};

const TEMPLATE: Template = {
  id: "0190a000-0000-7000-8000-000000000002",
  name: "Letterhead",
  description: null,
  instructions: null,
  is_default: true,
  owner: { id: "u1", name: "Ana Silva" },
  access: "use",
  shared: false,
  current: {
    no: 2,
    file_name: "firm.docx",
    size: 2048,
    placeholders: ["{{Counterparty}}"],
    note: null,
    reverted_from: null,
    created_at: "2026-11-10T00:00:00.000Z",
  },
  updated_at: "2026-11-10T00:00:00.000Z",
};

function serve(abilities: { manage: boolean; draft: boolean }) {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/abilities")) return json(abilities);
      if (url.endsWith("/prompts")) return json({ prompts: [PROMPT] });
      if (url.endsWith("/templates")) return json({ templates: [TEMPLATE] });
      return new Response(null, { status: 404 });
    }),
  );
}

beforeEach(() => {
  window.location.hash = "#/library/prompts";
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("library routes", () => {
  it("reads the tab from the address", () => {
    expect(parseLibraryRoute("#/library")).toEqual({ tab: "prompts" });
    expect(parseLibraryRoute("#/library/templates")).toEqual({ tab: "templates" });
    expect(parseLibraryRoute("#/library/nonsense")).toEqual({ tab: "prompts" });
    expect(parseLibraryRoute("#/vaults")).toBeNull();
    expect(libraryHash("workflows")).toBe("#/library/workflows");
  });
});

describe("handing a prompt to the composer", () => {
  it("passes the text across one navigation, once", () => {
    sendToComposer("Review the NDA for Acme.");
    expect(window.location.hash).toBe("#/");
    expect(takeComposerPrefill()).toBe("Review the NDA for Acme.");
    expect(takeComposerPrefill()).toBeNull();
  });
});

describe("LibraryApp", () => {
  it("shows prompts and fills a prompt's blanks before using it", { timeout: 20_000 }, async () => {
    serve({ manage: false, draft: true });
    render(<LibraryApp onLeave={() => {}} />);
    expect(screen.getByRole("status", { name: "Loading the Library" })).toBeTruthy();
    const list = await screen.findByRole("list", { name: "Saved prompts" });
    expect(within(list).getByText("NDA first pass")).toBeTruthy();
    expect(within(list).getByText("1 blanks")).toBeTruthy();

    fireEvent.click(within(list).getByRole("button", { name: "Use: NDA first pass" }));
    fireEvent.change(await screen.findByLabelText("counterparty"), {
      target: { value: "Acme Pty Ltd" },
    });
    expect(screen.getByText("Review the NDA for Acme Pty Ltd.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use in a thread" }));
    expect(window.location.hash).toBe("#/");
    expect(takeComposerPrefill()).toBe("Review the NDA for Acme Pty Ltd.");
  });

  it("hides manager actions from people who only draft", async () => {
    serve({ manage: false, draft: true });
    window.location.hash = "#/library/templates";
    render(<LibraryApp onLeave={() => {}} />);
    const list = await screen.findByRole("list", { name: "Firm templates" });
    expect(within(list).getByText("Default")).toBeTruthy();
    expect(within(list).getByRole("button", { name: "Preview PDF: Letterhead" })).toBeTruthy();
    expect(within(list).queryByRole("button", { name: /default: Letterhead/ })).toBeNull();
    expect(within(list).queryByRole("button", { name: "Delete: Letterhead" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Upload template" })).toBeNull();
  });

  it("offers upload and the default switch to managers", async () => {
    serve({ manage: true, draft: true });
    window.location.hash = "#/library/templates";
    render(<LibraryApp onLeave={() => {}} />);
    const list = await screen.findByRole("list", { name: "Firm templates" });
    await waitFor(() =>
      expect(
        within(list).getByRole("button", { name: "Stop using as default: Letterhead" }),
      ).toBeTruthy(),
    );
    expect(screen.getByRole("button", { name: "Upload template" })).toBeTruthy();
  });
});
