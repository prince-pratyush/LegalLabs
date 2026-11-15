import type { Meta, StoryObj } from "@storybook/react-vite";
import { ExportDialog } from "./export-dialog.js";

// The dialog renders in a portal, so the button is looked up on the document.
const clickDownload = () =>
  [...document.querySelectorAll("button")].find((b) => b.textContent === "Download")?.click();

const meta = {
  title: "Review tables/Export dialog",
  component: ExportDialog,
  args: { open: true, onOpenChange: () => {}, onExport: async () => {} },
} satisfies Meta<typeof ExportDialog>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Excel: Story = {};

export const Filtered: Story = { args: { filtered: true } };

export const Refused: Story = {
  args: {
    onExport: async () => {
      throw new Error("The source vault doesn't allow downloads, so this table can't be exported.");
    },
  },
  play: async () => clickDownload(),
};

// Never resolves, so the button stays in its busy state.
export const Loading: Story = {
  args: { onExport: () => new Promise(() => {}) },
  play: async () => clickDownload(),
};
