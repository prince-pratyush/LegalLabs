import type { Meta, StoryObj } from "@storybook/react-vite";
import { ExportDialog } from "./export-dialog.js";

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
  play: async ({ canvasElement }) => {
    const button = [...canvasElement.ownerDocument.querySelectorAll("button")].find(
      (b) => b.textContent === "Download",
    );
    button?.click();
  },
};

// Never resolves, so the button stays in its busy state.
export const Loading: Story = {
  args: { onExport: () => new Promise(() => {}) },
  play: Refused.play,
};
