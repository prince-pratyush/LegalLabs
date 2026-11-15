import type { Meta, StoryObj } from "@storybook/react-vite";
import { type ComponentProps, useState } from "react";
import { fn } from "storybook/test";
import { blankRule, toEditable } from "./draft.js";
import { sampleRules } from "./fixtures.js";
import { RuleEditor, RuleEditorSkeleton } from "./rule-editor.js";

const [liability, law] = sampleRules.map(toEditable);

// Stateful, so the story can be typed into like the real builder.
function Editable(props: ComponentProps<typeof RuleEditor>) {
  const [rule, setRule] = useState(props.rule);
  const [expanded, setExpanded] = useState(props.expanded);
  return (
    <ul className="grid max-w-[720px]">
      <RuleEditor
        {...props}
        rule={rule}
        expanded={expanded}
        onChange={setRule}
        onToggle={() => setExpanded((open) => !open)}
      />
    </ul>
  );
}

const meta = {
  title: "Playbook/Rule editor",
  component: RuleEditor,
  render: (args) => <Editable {...args} />,
  args: {
    rule: liability ?? blankRule(),
    index: 0,
    count: 2,
    expanded: true,
    onToggle: fn(),
    onChange: fn(),
    onMove: fn(),
    onRemove: fn(),
  },
} satisfies Meta<typeof RuleEditor>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Expanded: Story = {};
export const Collapsed: Story = { args: { expanded: false } };
export const UncheckedSource: Story = { args: { rule: law ?? blankRule(), index: 1 } };
export const WithProblems: Story = {
  args: {
    rule: { ...blankRule(), jurisdictions: "Narnia" },
    problems: {
      title: "Add a title.",
      standard_position: "Add the standard position.",
      jurisdictions: "Use codes like US, UK or US-CA, not NARNIA.",
    },
  },
};
export const ReadOnly: Story = { args: { readOnly: true } };
export const Loading: Story = { render: () => <RuleEditorSkeleton /> };
