import type { CreateTableBody, ReviewTable } from "@legallabs/contracts";
import { type CreateRequest, CreateTablePanel, TableList, Toaster, toast } from "@legallabs/ui";
import { ArrowLeft } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import { vaultApi } from "../vaults/api.js";
import { useHash } from "../vaults/route.js";
import { messageOf, tableApi } from "./api.js";
import { goTables, parseTableRoute } from "./route.js";
import { TablePage } from "./TablePage.js";

/** Uploads go in first, since a table of uploads names documents that already exist. */
export async function createBody(
  request: CreateRequest,
  upload: (file: File) => Promise<{ id: string }> = api.upload,
): Promise<CreateTableBody> {
  const name = request.name ? { name: request.name } : {};
  const source = request.source;
  if (source.kind !== "uploads") return { ...name, source };
  const ids: string[] = [];
  for (const file of source.files) ids.push((await upload(file)).id);
  return { ...name, source: { kind: "uploads", upload_ids: ids } };
}

export function TablesApp({ onLeave }: { onLeave: () => void }) {
  const route = parseTableRoute(useHash());
  return (
    <>
      <Toaster />
      {route?.page === "table" ? (
        <TablePage
          tableId={route.tableId}
          onBack={() => goTables({ page: "list", threadId: null })}
        />
      ) : (
        <ListPage threadId={route?.threadId ?? null} onLeave={onLeave} />
      )}
    </>
  );
}

function ListPage({ threadId, onLeave }: { threadId: string | null; onLeave: () => void }) {
  const [tables, setTables] = useState<ReviewTable[] | null>(null);
  const [starredOnly, setStarredOnly] = useState(false);
  const [creating, setCreating] = useState(threadId !== null);
  const [vaults, setVaults] = useState<{ id: string; name: string }[]>([]);
  const [threads, setThreads] = useState<{ id: string; title: string }[]>([]);

  useEffect(() => {
    let live = true;
    // Starring is filtered here too, so the server's list stays the source of truth.
    tableApi.list(false).then(
      (next) => live && setTables(next),
      (err) => toast.error(messageOf(err)),
    );
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!creating) return;
    vaultApi.list().then(setVaults, () => setVaults([]));
    // Recent threads, the same list the sidebar shows.
    api.history().then(
      (page) => setThreads(page.items.map((t) => ({ id: t.id, title: t.title }))),
      () => setThreads([]),
    );
  }, [creating]);

  const loadTree = useCallback(async (vaultId: string) => {
    const tree = await vaultApi.tree(vaultId, {});
    return { folders: tree.folders, files: tree.files };
  }, []);

  const star = async (table: ReviewTable, on: boolean) => {
    setTables((list) => list?.map((t) => (t.id === table.id ? { ...t, starred: on } : t)) ?? null);
    try {
      await tableApi.star(table.id, on);
    } catch (err) {
      setTables(
        (list) => list?.map((t) => (t.id === table.id ? { ...t, starred: !on } : t)) ?? null,
      );
      toast.error(messageOf(err));
    }
  };

  const create = async (request: CreateRequest) => {
    try {
      const table = await tableApi.create(await createBody(request));
      goTables({ page: "table", tableId: table.id });
    } catch (err) {
      throw new Error(messageOf(err));
    }
  };

  return (
    <div className="flex h-dvh">
      <main className="min-w-0 flex-1 overflow-y-auto px-8 py-6">
        <button
          type="button"
          onClick={onLeave}
          className="mb-4 inline-flex items-center gap-1 rounded-sm text-fg-muted hover:text-fg"
        >
          <ArrowLeft aria-hidden className="size-4" />
          Back to workspace
        </button>
        <TableList
          tables={tables ?? []}
          loading={tables === null}
          starredOnly={starredOnly}
          onStarredOnlyChange={setStarredOnly}
          onStar={(t, on) => {
            const table = tables?.find((x) => x.id === t.id);
            if (table) void star(table, on);
          }}
          onOpen={(t) => goTables({ page: "table", tableId: t.id })}
          onCreate={() => setCreating(true)}
        />
      </main>
      {creating && (
        <CreateTablePanel
          vaults={vaults}
          threads={threads}
          loadTree={loadTree}
          onCreate={create}
          onClose={() => {
            setCreating(false);
            if (threadId) goTables({ page: "list", threadId: null });
          }}
          {...(threadId ? { initialThreadId: threadId } : {})}
        />
      )}
    </div>
  );
}
