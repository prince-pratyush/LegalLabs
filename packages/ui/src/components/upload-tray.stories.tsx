import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { type UploadItem, UploadTray } from "./upload-tray.js";

const ITEMS: UploadItem[] = [
  { id: "1", name: "Master services agreement.pdf", state: "ready" },
  { id: "2", name: "Side letter – pricing.docx", state: "processing" },
  { id: "3", name: "Board minutes 2024-03.pdf", state: "uploading", progress: 0.42 },
  { id: "4", name: "Disclosure schedule.xlsx", state: "queued" },
  {
    id: "5",
    name: "Scanned lease.pdf",
    state: "failed",
    message: "This file couldn't be read. It may be damaged.",
  },
  {
    id: "6",
    name: "Photos.heic",
    state: "rejected",
    message: "This type can't be read. Use PDF, Word, Excel, email, TXT or Markdown.",
  },
];

const meta = {
  title: "Kit/Upload tray",
  component: UploadTray,
  args: { items: ITEMS, onRetry: fn(), onClose: fn() },
} satisfies Meta<typeof UploadTray>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Mixed: Story = {};
export const Loading: Story = {
  args: {
    items: ITEMS.map((item, i) => ({
      ...item,
      state: i === 0 ? "uploading" : "waiting",
      progress: 0.1,
    })),
  },
};
export const AllReady: Story = {
  args: { items: ITEMS.slice(0, 4).map((item) => ({ ...item, state: "ready" as const })) },
};
