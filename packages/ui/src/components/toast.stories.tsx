import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect } from "react";
import { Button } from "./button.js";
import { Toaster, toast } from "./toast.js";

function Demo({ show }: { show: () => void }) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: show once, when the story opens
  useEffect(() => {
    show();
  }, []);
  return (
    <>
      <Button variant="secondary" onClick={show}>
        Show again
      </Button>
      <Toaster />
    </>
  );
}

const meta = {
  title: "Kit/Toast",
  component: Toaster,
} satisfies Meta<typeof Toaster>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Neutral: Story = {
  render: () => <Demo show={() => toast("Thread renamed")} />,
};
export const Success: Story = {
  render: () => (
    <Demo show={() => toast.success("msa.pdf is ready", { description: "10 pages read." })} />
  ),
};
export const Failure: Story = {
  render: () => (
    <Demo
      show={() =>
        toast.error("Upload failed", {
          description: "The file is encrypted.",
          action: { label: "Retry", onClick: () => {} },
        })
      }
    />
  ),
};
