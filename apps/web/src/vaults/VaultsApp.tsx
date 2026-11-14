import { AppShell, Button, Skeleton } from "@legallabs/ui";
import { Vault as VaultIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AdminVaults } from "./AdminVaults.js";
import { type Vault, vaultApi } from "./api.js";
import { RecycleBin } from "./RecycleBin.js";
import { go, parseRoute, type Route, useHash } from "./route.js";
import { messageOf } from "./shared.js";
import { VaultList } from "./VaultList.js";
import { VaultView } from "./VaultView.js";

/** Vaults, a vault's files, its bin and the admin list, chosen by the address. */
export function VaultsApp({ onLeave }: { onLeave: () => void }) {
  const route = parseRoute(useHash()) ?? { page: "list" };
  const [vaults, setVaults] = useState<(Vault & { files: number })[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    vaultApi.list().then(setVaults, (err) => setError(messageOf(err)));
  }, []);
  useEffect(refresh, [refresh]);

  return (
    <AppShell
      brand="LegalLabs"
      sidebarLabel="Vaults"
      commands={[
        {
          id: "vaults",
          kind: "action",
          group: "Vaults",
          label: "All vaults",
          run: () => go({ page: "list" }),
        },
        {
          id: "admin",
          kind: "action",
          group: "Vaults",
          label: "Admin: every vault",
          run: () => go({ page: "admin" }),
        },
        { id: "threads", kind: "action", group: "Go to", label: "Threads", run: onLeave },
      ]}
      sidebar={
        <div className="grid min-w-0 gap-2">
          <Button variant="quiet" size="sm" className="justify-start" onClick={onLeave}>
            Back to threads
          </Button>
          <h2 className="text-caption font-semibold text-fg-muted uppercase">Vaults</h2>
          {vaults === null ? (
            <div aria-busy="true" className="grid gap-2">
              <Skeleton className="h-5" />
              <Skeleton className="h-5" />
            </div>
          ) : (
            <ul className="grid gap-0.5">
              {vaults.map((v) => (
                <li key={v.id}>
                  <button
                    type="button"
                    aria-current={"vaultId" in route && route.vaultId === v.id ? "page" : undefined}
                    onClick={() => go({ page: "vault", vaultId: v.id, folderId: null })}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-ui hover:tint-hover aria-[current=page]:bg-bg-raised"
                  >
                    <VaultIcon aria-hidden className="size-4 shrink-0 text-fg-muted" />
                    <span className="truncate">{v.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      }
    >
      <main id="main" className="flex min-w-0 flex-1 flex-col overflow-auto p-6">
        {error && (
          <p role="alert" className="mb-4 text-destructive">
            {error}
          </p>
        )}
        <Page route={route} vaults={vaults} onChanged={refresh} />
      </main>
    </AppShell>
  );
}

function Page({
  route,
  vaults,
  onChanged,
}: {
  route: Route;
  vaults: (Vault & { files: number })[] | null;
  onChanged: () => void;
}) {
  switch (route.page) {
    case "list":
      return <VaultList vaults={vaults} onChanged={onChanged} />;
    case "admin":
      return <AdminVaults onChanged={onChanged} />;
    case "bin":
      return <RecycleBin vaultId={route.vaultId} />;
    case "vault":
      return (
        <VaultView
          key={route.vaultId}
          vaultId={route.vaultId}
          folderId={route.folderId}
          onChanged={onChanged}
        />
      );
  }
}
