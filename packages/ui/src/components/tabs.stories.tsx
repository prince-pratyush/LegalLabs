import type { Meta, StoryObj } from "@storybook/react-vite";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs.js";

const meta: Meta<typeof Tabs> = {
  title: "Kit/Tabs",
  component: Tabs,
  args: { defaultValue: "thread" },
  render: (args) => (
    <Tabs {...args} className="max-w-md">
      <TabsList>
        <TabsTrigger value="thread">Thread</TabsTrigger>
        <TabsTrigger value="document">Document</TabsTrigger>
        <TabsTrigger value="history" disabled>
          History
        </TabsTrigger>
      </TabsList>
      <TabsContent value="thread">The conversation.</TabsContent>
      <TabsContent value="document">The cited document.</TabsContent>
    </Tabs>
  ),
};
export default meta;
type Story = StoryObj<typeof meta>;

export const FirstSelected: Story = {};
export const SecondSelected: Story = { args: { defaultValue: "document" } };
