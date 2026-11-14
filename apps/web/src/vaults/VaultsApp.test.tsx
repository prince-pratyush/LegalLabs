import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Vault, VaultStats } from "./api.js";
import { parseRoute, routeHash } from "./route.js";
import { uploadAll } from "./uploads.js";
import { RecycleBin, SharePanel, statsLine, VaultList, VaultView } from "./VaultsApp.js";

// The real table is virtualised, and jsdom lays nothing out, so it would draw no rows.
vi.mock("@legallabs/ui", async (original) => ({
  ...(await original<typeof import("@legallabs/ui")>()),
  DataTable: <T extends object>(props: {
    label: string;
    columns: { id: string; header: string; cell: (row: T) => ReactNode }[];
    rows: T[];
    getRowId: (row: T) => string;
    loading?: boolean;
  }) => (
    <table aria-label={props.label} aria-busy={props.loading || undefined}>
      <tbody>
        {props.rows.map((row) => (
          <tr key={props.getRowId(row)}>
            {props.columns.map((column) => (
              <td key={column.id}>{column.cell(row)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  ),
}));

const ID = "0190a000-0000-7000-8000-00000000000a";
const FOLDER = "0190a000-0000-7000-8000-00000000000b";
const FILE = "0190a000-0000-7000-8000-00000000000c";

const vault = (access: Vault["my_access"]): Vault => ({
  id: ID,
  name: "Project Atlas",
  description: "",
  matter_id: null,
  owner_id: "u",
  my_access: access,
  content_controls: { allow_download: true, allow_duplicate: true, show_review_prompts: true },
  retention_hours: null,
  created_at: "2026-11-10T00:00:00.000Z",
  updated_at: "2026-11-10T00:00:00.000Z",
  deleted_at: null,
});

const STATS: VaultStats = {
  files: 420,
  bytes: 1000,
  hidden: 3,
  queued: 2,
  processing: 0,
  ready: 410,
  failed: 8,
  max_files: 100_000,
  max_bytes: 1,
};

type Handler = (body: unknown) => [number, unknown];

function serve(routes: Record<string, Handler>) {
  const sent: { route: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = input.split("?")[0] ?? input;
      const route = `${init?.method ?? "GET"} ${path}`;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
      sent.push({ route, body });
      const [status, json] = routes[route]?.(body) ?? [404, { code: "NOT_FOUND", message: "No." }];
      return new Response(JSON.stringify(json), { status });
    }),
  );
  return sent;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("routes", () => {
  it("round-trips every page through the address", () => {
    for (const route of [
      { page: "list" },
      { page: "admin" },
      { page: "bin", vaultId: ID },
      { page: "vault", vaultId: ID, folderId: null },
      { page: "vault", vaultId: ID, folderId: FOLDER },
    ] as const) {
      expect(parseRoute(routeHash(route))).toEqual(route);
    }
    expect(parseRoute("#/threads")).toBeNull();
    expect(parseRoute("")).toBeNull();
  });
});

describe("vault pages", () => {
  it("says how far reading has got", () => {
    expect(statsLine(STATS)).toBe("410 of 420 ready · 2 reading · 8 failed");
  });

  it("shows a loading table until the vaults arrive", () => {
    render(<VaultList vaults={null} onChanged={() => {}} />);
    expect(screen.getByRole("table", { name: "Vaults" }).getAttribute("aria-busy")).toBe("true");
  });

  it("lists a vault's folders and files, and counts the walled ones without naming them", async () => {
    serve({
      [`GET /api/v1/vaults/${ID}`]: () => [200, { vault: vault("owner"), stats: STATS }],
      [`GET /api/v1/vaults/${ID}/tree`]: () => [
        200,
        {
          path: [],
          folders: [{ id: FOLDER, name: "Contracts", parent_id: null }],
          files: [
            {
              id: FILE,
              version_id: FILE,
              folder_id: null,
              name: "msa.pdf",
              mime: "application/pdf",
              size: 2048,
              state: "failed",
              failure_reason: "NO_TEXT",
              page_count: null,
              updated_at: "2026-11-10T00:00:00.000Z",
            },
          ],
          next_cursor: null,
        },
      ],
    });
    render(<VaultView vaultId={ID} folderId={null} onChanged={() => {}} />);
    const table = await screen.findByRole("table", { name: /Files in Project Atlas/ });
    await waitFor(() => expect(within(table).getByText("msa.pdf")).toBeTruthy());
    expect(within(table).getByRole("button", { name: /Contracts/ })).toBeTruthy();
    expect(within(table).getByText("Failed")).toBeTruthy();
    expect(screen.getByText("410 of 420 ready · 2 reading · 8 failed")).toBeTruthy();
    expect(screen.getByText("3 files are hidden by matter restrictions")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Upload files" })).toBeTruthy();
  });

  it("offers a viewer no way to change the vault", async () => {
    serve({
      [`GET /api/v1/vaults/${ID}`]: () => [
        200,
        { vault: vault("view"), stats: { ...STATS, hidden: 0 } },
      ],
      [`GET /api/v1/vaults/${ID}/tree`]: () => [
        200,
        { path: [], folders: [], files: [], next_cursor: null },
      ],
    });
    render(<VaultView vaultId={ID} folderId={null} onChanged={() => {}} />);
    await screen.findByText("Nothing here yet");
    for (const name of ["Upload files", "Share", "Settings", "Recycle bin"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  it("restores an item from the bin", async () => {
    const sent = serve({
      [`GET /api/v1/vaults/${ID}/bin`]: () => [
        200,
        {
          items: [
            {
              kind: "document",
              id: FILE,
              name: "old.pdf",
              deleted_at: "2026-11-10T00:00:00.000Z",
              deleted_reason: "retention",
              purge_at: "2099-01-01T00:00:00.000Z",
            },
          ],
        },
      ],
      [`POST /api/v1/vaults/${ID}/restore`]: () => [200, { items: 1 }],
    });
    render(<RecycleBin vaultId={ID} />);
    expect(await screen.findByText("Retention policy")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restore old.pdf" }));
    await waitFor(() =>
      expect(sent).toContainEqual({
        route: `POST /api/v1/vaults/${ID}/restore`,
        body: { document_ids: [FILE], folder_ids: [] },
      }),
    );
  });

  it("names people a wall keeps out when sharing", async () => {
    serve({
      [`GET /api/v1/vaults/${ID}/shares`]: () => [
        200,
        {
          grants: [
            { principal_type: "user", principal_id: "ben", level: "view", name: "ben@acme.test" },
          ],
          workspace_view: false,
        },
      ],
      [`PUT /api/v1/vaults/${ID}/shares`]: () => [
        200,
        { grants: [], workspace_view: false, denied_by_wall: ["ben"] },
      ],
    });
    render(<SharePanel vault={vault("owner")} onClose={() => {}} />);
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Everyone in the workspace can view" }),
    );
    expect(await screen.findByText(/ben@acme.test is walled off/)).toBeTruthy();
  });
});

describe("uploading", () => {
  it("never sends a refused file and waits out a busy server", async () => {
    let busy = true;
    const sent = serve({
      [`POST /api/v1/vaults/${ID}/uploads`]: () => [
        200,
        {
          accepted: [{ client_ref: "0" }],
          rejected: [{ client_ref: "1", reason: "UNSUPPORTED_TYPE" }],
        },
      ],
      [`POST /api/v1/vaults/${ID}/files`]: () => {
        if (busy) {
          busy = false;
          return [503, { code: "BUSY", message: "Busy" }];
        }
        return [202, { file: { id: FILE, state: "queued", failure_reason: null } }];
      },
    });
    const changes: [string, unknown][] = [];
    await uploadAll(
      ID,
      null,
      [{ file: new File(["x"], "a.pdf") }, { file: new File(["x"], "b.heic") }],
      (id, change) => changes.push([id, change.state]),
      async () => {},
    );
    expect(sent.filter((s) => s.route.endsWith("/files"))).toHaveLength(2);
    expect(changes).toEqual([
      ["1", "rejected"],
      ["0", "uploading"],
      ["0", "queued"],
    ]);
  });
});
