import type { PlaybookSummary } from "@legallabs/contracts";
import { BookCheck } from "lucide-react";
import { DataTable, type TableColumn } from "../data-table.js";
import { EmptyState } from "../empty-state.js";
import { PlaybookStatus } from "./badges.js";

const date = new Intl.DateTimeFormat("en", { dateStyle: "medium" });

const columns: TableColumn<PlaybookSummary>[] = [
  { id: "name", header: "Playbook", cell: (p) => p.name, sortValue: (p) => p.name.toLowerCase() },
  {
    id: "type",
    header: "Contract type",
    cell: (p) => p.contract_type,
    sortValue: (p) => p.contract_type.toLowerCase(),
    width: 180,
  },
  {
    id: "status",
    header: "Status",
    cell: (p) => <PlaybookStatus status={p.status} />,
    sortValue: (p) => p.status,
    width: 150,
  },
  {
    id: "rules",
    header: "Rules",
    cell: (p) => p.rule_count,
    sortValue: (p) => p.rule_count,
    align: "end",
    width: 88,
  },
  {
    id: "version",
    header: "Version",
    cell: (p) => `v${p.version_no}`,
    sortValue: (p) => p.version_no,
    align: "end",
    width: 96,
  },
  {
    id: "updated",
    header: "Updated",
    cell: (p) => date.format(new Date(p.updated_at)),
    sortValue: (p) => p.updated_at,
    width: 140,
  },
];

/** Every playbook the caller can see; Enter or a click opens the builder. */
export function PlaybookTable({
  rows,
  loading = false,
  onOpen,
  onCreate,
  filtered = false,
  height = 480,
}: {
  rows: readonly PlaybookSummary[];
  loading?: boolean;
  onOpen: (playbook: PlaybookSummary) => void;
  onCreate: () => void;
  /** True when filters hide rows, so the empty state says so. */
  filtered?: boolean;
  height?: number;
}) {
  return (
    <DataTable
      label="Playbooks"
      columns={columns}
      rows={rows}
      getRowId={(p) => p.id}
      onActivate={onOpen}
      loading={loading}
      height={height}
      empty={
        <EmptyState
          icon={BookCheck}
          title={filtered ? "No playbooks match" : "No playbooks yet"}
          description="A playbook holds your standard positions for one type of contract, so reviews check every draft the same way."
          action={{ label: "Create a playbook", onClick: onCreate }}
        />
      }
    />
  );
}
