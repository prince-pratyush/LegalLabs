import type { Playbook, PlaybookVersion } from "@legallabs/contracts";
import {
  PlaybookBuilder,
  PlaybookBuilderSkeleton,
  type PlaybookDraft,
  toEditable,
  toRuleInput,
  useMobile,
  VersionList,
  VersionListSkeleton,
} from "@legallabs/ui";
import { useCallback, useEffect, useState } from "react";
import { ApiError, messageOf } from "../api.js";
import { goReviews } from "../reviews/route.js";
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
  const mobile = useMobile();
  const [playbook, setPlaybook] = useState<Playbook | null>(null);
  const [draft, setDraft] = useState<PlaybookDraft | null>(null);
  const [past, setPast] = useState<PlaybookDraft | null>(null);
  const [versions, setVersions] = useState<PlaybookVersion[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  const show = useCallback((p: Playbook) => {
    setPlaybook(p);
    setDraft(toDraft(p));
    setDirty(false);
    setStale(false);
    playbookApi.versions(p.id).then(setVersions, () => setVersions([]));
  }, []);

  const reload = useCallback(() => {
    setError(null);
    playbookApi.get(playbookId).then(show, (err) => setError(messageOf(err)));
  }, [playbookId, show]);
  useEffect(reload, [reload]);

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
      // Another save landed first; keep the edits on screen and offer a reload instead.
      if (err instanceof ApiError && err.code === "STALE") setStale(true);
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
      access={mobile ? "view" : playbook.access}
      dirty={dirty}
      busy={busy}
      error={error}
      viewingVersion={viewing}
      publishedVersionNo={playbook.published_version_no ?? null}
      unpublishedChanges={playbook.has_unpublished_changes ?? false}
      stale={stale}
      onReload={reload}
      onBackToCurrent={() => goPlaybooks({ page: "playbook", playbookId, version: null })}
      onSave={() =>
        act(() =>
          playbookApi.update(playbookId, {
            base_version_no: playbook.version_no,
            name: draft.name.trim(),
            contract_type: draft.contract_type.trim(),
            guidance: draft.guidance.trim() ? draft.guidance : null,
            rules: draft.rules.map(toRuleInput),
          }),
        )
      }
      onPublish={() => act(() => playbookApi.publish(playbookId))}
      onUnpublish={() => act(() => playbookApi.unpublish(playbookId))}
      onReview={() => goReviews({ page: "new", playbookId, documentId: null })}
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
