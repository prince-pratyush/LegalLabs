import type { Playbook, PlaybookVersion } from "@legallabs/contracts";
import {
  PlaybookBuilder,
  PlaybookBuilderSkeleton,
  type PlaybookDraft,
  toEditable,
  toRuleInput,
  VersionList,
  VersionListSkeleton,
} from "@legallabs/ui";
import { useCallback, useEffect, useState } from "react";
import { messageOf } from "../vaults/shared.js";
import { playbookApi } from "./api.js";
import { goPlaybooks } from "./route.js";

const toDraft = (p: Playbook): PlaybookDraft => ({
  name: p.name,
  contract_type: p.contract_type,
  guidance: p.guidance ?? "",
  rules: p.rules.map(toEditable),
});

/** The builder for one playbook, or a past version of it read-only. */
export function PlaybookPage({
  playbookId,
  version,
  onChanged,
}: {
  playbookId: string;
  version: number | null;
  onChanged: () => void;
}) {
  const [playbook, setPlaybook] = useState<Playbook | null>(null);
  const [draft, setDraft] = useState<PlaybookDraft | null>(null);
  const [past, setPast] = useState<PlaybookDraft | null>(null);
  const [versions, setVersions] = useState<PlaybookVersion[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const show = useCallback((p: Playbook) => {
    setPlaybook(p);
    setDraft(toDraft(p));
    setDirty(false);
    playbookApi.versions(p.id).then(setVersions, () => setVersions([]));
  }, []);

  useEffect(() => {
    playbookApi.get(playbookId).then(show, (err) => setError(messageOf(err)));
  }, [playbookId, show]);

  const viewing = version !== null && playbook && version !== playbook.version_no ? version : null;
  useEffect(() => {
    setPast(null);
    if (viewing === null) return;
    playbookApi.version(playbookId, viewing).then(
      (p) => setPast(toDraft(p)),
      (err) => setError(messageOf(err)),
    );
  }, [playbookId, viewing]);

  const act = async (work: () => Promise<Playbook>) => {
    setBusy(true);
    setError(null);
    try {
      show(await work());
      onChanged();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  if (!playbook || !draft) {
    return error ? (
      <p role="alert" className="text-destructive">
        {error}
      </p>
    ) : (
      <PlaybookBuilderSkeleton />
    );
  }

  return (
    <PlaybookBuilder
      draft={viewing !== null ? (past ?? { ...draft, rules: [] }) : draft}
      onChange={(next) => {
        setDraft(next);
        setDirty(true);
      }}
      status={playbook.status}
      versionNo={playbook.version_no}
      access={playbook.access}
      dirty={dirty}
      busy={busy}
      error={error}
      viewingVersion={viewing}
      onBackToCurrent={() => goPlaybooks({ page: "playbook", playbookId, version: null })}
      onSave={() =>
        act(() =>
          playbookApi.update(playbookId, {
            name: draft.name.trim(),
            contract_type: draft.contract_type.trim(),
            guidance: draft.guidance.trim() ? draft.guidance : null,
            rules: draft.rules.map(toRuleInput),
          }),
        )
      }
      onPublish={() => act(() => playbookApi.publish(playbookId))}
      onUnpublish={() => act(() => playbookApi.unpublish(playbookId))}
      aside={
        versions === null ? (
          <VersionListSkeleton />
        ) : (
          <VersionList
            versions={versions}
            current={playbook.version_no}
            viewing={viewing}
            onView={(no) =>
              goPlaybooks({
                page: "playbook",
                playbookId,
                version: no === playbook.version_no ? null : no,
              })
            }
          />
        )
      }
    />
  );
}
