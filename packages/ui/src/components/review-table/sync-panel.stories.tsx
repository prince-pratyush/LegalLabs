import type { Meta, StoryObj } from "@storybook/react-vite";
import { SyncIndicator, type SyncInfo, SyncPanel } from "./sync-panel.js";

const OFF: SyncInfo = {
  mode: "off",
  folder_ids: null,
  notify: false,
  state: "off",
  pending_rows: 0,
  removed_rows: 0,
  last_synced_at: null,
};

const FOLDERS = [
  { id: "f1", name: "Loans" },
  { id: "f2", name: "Leases" },
];

const meta = {
  title: "Review tables/Vault sync",
  component: SyncPanel,
  args: {
    sync: OFF,
    folders: FOLDERS,
    onSave: async () => {},
    onSyncNow: async () => {},
    onClose: () => {},
  },
} satisfies Meta<typeof SyncPanel>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Off: Story = {};

export const EntireVault: Story = {
  args: {
    sync: {
      ...OFF,
      mode: "entire_vault",
      state: "idle",
      notify: true,
      last_synced_at: "2026-11-21T01:00:00Z",
      removed_rows: 2,
    },
  },
};

export const SelectedFolders: Story = {
  args: {
    sync: {
      ...OFF,
      mode: "selected_folders",
      folder_ids: ["f1"],
      state: "pending",
      pending_rows: 3,
    },
  },
};

export const Indicators: Story = {
  render: () => (
    <div className="flex gap-2">
      <SyncIndicator
        sync={{ ...OFF, mode: "entire_vault", state: "pending", pending_rows: 3 }}
        onClick={() => {}}
      />
      <SyncIndicator sync={{ ...OFF, mode: "entire_vault", state: "idle" }} onClick={() => {}} />
    </div>
  ),
};
