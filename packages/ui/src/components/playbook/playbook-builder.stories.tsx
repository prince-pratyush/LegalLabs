import type { Meta, StoryObj } from "@storybook/react-vite";
import { type ComponentProps, useState } from "react";
import { fn } from "storybook/test";
import { type PlaybookDraft, toEditable } from "./draft.js";
import { sampleRules, sampleVersions } from "./fixtures.js";
import { PlaybookBuilder, PlaybookBuilderSkeleton } from "./playbook-builder.js";
import { VersionList } from "./version-list.js";

const draft: PlaybookDraft = {
  name: "SaaS MSA",
  contract_type: "MSA",
  guidance: "We are the customer and usually review the supplier's paper.",
  rules: sampleRules.map(toEditable),
};

function Live(props: ComponentProps<typeof PlaybookBuilder>) {
  const [value, setValue] = useState(props.draft);
  return (
    <PlaybookBuilder
      {...props}
      draft={value}
      dirty={props.dirty || value !== props.draft}
      onChange={setValue}
    />
  );
}

const meta = {
  title: "Playbook/Builder",
  component: PlaybookBuilder,
  render: (args) => <Live {...args} />,
  args: {
    draft,
    onChange: fn(),
    status: "unpublished",
    versionNo: 3,
    access: "manage",
    dirty: false,
    onSave: fn(),
    onPublish: fn(),
    onUnpublish: fn(),
    onBackToCurrent: fn(),
    aside: <VersionList versions={sampleVersions} current={3} onView={fn()} />,
  },
} satisfies Meta<typeof PlaybookBuilder>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Approver: Story = {};
export const Published: Story = { args: { status: "published" } };
export const Author: Story = { args: { access: "edit" } };
export const Viewer: Story = { args: { access: "view", status: "published" } };
export const UnsavedChanges: Story = { args: { dirty: true } };
export const PastVersion: Story = { args: { viewingVersion: 1 } };
export const SaveFailed: Story = {
  args: { dirty: true, error: "Each rule needs its own title." },
};
export const Empty: Story = {
  args: { draft: { name: "", contract_type: "", guidance: "", rules: [] }, versionNo: 1 },
};
export const PublishedWithDraftChanges: Story = {
  args: { status: "published", publishedVersionNo: 2, unpublishedChanges: true },
};
export const AuthorEditingAfterPublish: Story = {
  args: { status: "published", access: "edit", publishedVersionNo: 2, unpublishedChanges: true },
};
export const ChangedBySomeoneElse: Story = { args: { dirty: true, stale: true, onReload: fn() } };
export const Loading: Story = { render: () => <PlaybookBuilderSkeleton /> };
