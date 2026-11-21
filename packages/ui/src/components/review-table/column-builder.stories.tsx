import type { Meta, StoryObj } from "@storybook/react-vite";
import { ColumnBuilder } from "./column-builder.js";
import type { NewColumn } from "./presets.js";

const PROPOSALS: NewColumn[] = [
  { label: "Rent", type: "currency", prompt: "What is the annual base rent?", options: {} },
  { label: "Lease start", type: "date", prompt: "When does the lease term start?", options: {} },
  { label: "Break clause", type: "verbatim", prompt: "Quote the break clause.", options: {} },
];

const meta = {
  title: "Review tables/Column builder",
  component: ColumnBuilder,
  args: {
    onGenerate: async () => PROPOSALS,
    onAdd: () => {},
    onClose: () => {},
    instructions: "Answer as of the latest amendment.",
  },
  decorators: [(Story) => <div className="flex h-[36rem] justify-end">{<Story />}</div>],
} satisfies Meta<typeof ColumnBuilder>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

// Never resolves, so the panel stays in its loading state.
export const Loading: Story = {
  args: { onGenerate: () => new Promise<NewColumn[]>(() => {}) },
  play: async ({ canvasElement }) => {
    const area = canvasElement.querySelector("textarea");
    const form = area?.closest("form");
    if (!area || !form) return;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(area, "Lease terms");
    area.dispatchEvent(new Event("input", { bubbles: true }));
    form.requestSubmit();
  },
};
