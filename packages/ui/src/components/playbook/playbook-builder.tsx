import { PLAYBOOK_LIMITS, type PlaybookLevel } from "@legallabs/contracts";
import { Plus } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { Button } from "../button.js";
import { Field, Input, Textarea } from "../field.js";
import { Skeleton } from "../status.js";
import { PlaybookStatus } from "./badges.js";
import { blankRule, checkDraft, isClean, moveRule, type PlaybookDraft } from "./draft.js";
import { RuleEditor, RuleEditorSkeleton } from "./rule-editor.js";

const ACCESS: Record<PlaybookLevel, string> = {
  view: "You can view this playbook.",
  edit: "You can edit this playbook. An approver publishes it.",
  manage: "You can edit, publish and share this playbook.",
};

/**
 * The playbook editor: global details, the rule list and the save and publish actions.
 * Controlled, so the page decides when a save happens and what a version holds.
 */
export function PlaybookBuilder({
  draft,
  onChange,
  status,
  versionNo,
  access,
  dirty,
  busy = false,
  error,
  viewingVersion = null,
  onSave,
  onPublish,
  onUnpublish,
  onBackToCurrent,
  aside,
}: {
  draft: PlaybookDraft;
  onChange: (draft: PlaybookDraft) => void;
  status: "published" | "unpublished";
  versionNo: number;
  access: PlaybookLevel;
  dirty: boolean;
  busy?: boolean;
  error?: string | null;
  /** A past version on screen: shown read-only. */
  viewingVersion?: number | null;
  onSave: () => void;
  onPublish: () => void;
  onUnpublish: () => void;
  onBackToCurrent?: () => void;
  /** Version history, beside the rules on wide screens. */
  aside?: ReactNode;
}) {
  const reviewHint = useId();
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const past = viewingVersion !== null;
  const readOnly = past || access === "view";
  const problems = checkDraft(draft);
  const clean = isClean(problems);
  const full = draft.rules.length >= PLAYBOOK_LIMITS.rules;

  const toggle = (key: string) =>
    setOpen((keys) => {
      const next = new Set(keys);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const setRules = (rules: PlaybookDraft["rules"]) => onChange({ ...draft, rules });
  const add = () => {
    const rule = blankRule();
    setOpen((keys) => new Set(keys).add(rule.key));
    setRules([...draft.rules, rule]);
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_240px]">
      <div className="grid min-w-0 content-start gap-6">
        <header className="grid gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-title font-semibold">{draft.name.trim() || "Untitled playbook"}</h1>
            <PlaybookStatus status={status} />
            <span className="text-fg-muted">
              {past ? `Version ${viewingVersion} of ${versionNo}` : `Version ${versionNo}`}
            </span>
          </div>
          <p className="text-fg-muted">{ACCESS[access]}</p>
          {past ? (
            <div className="flex items-center gap-3">
              <p>You are looking at an earlier version. It can't be changed.</p>
              {onBackToCurrent && (
                <Button variant="secondary" size="sm" onClick={onBackToCurrent}>
                  Back to the current version
                </Button>
              )}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {access !== "view" && (
                <Button onClick={onSave} disabled={busy || !dirty || !clean}>
                  {busy ? "Saving…" : "Save version"}
                </Button>
              )}
              {access === "manage" && status === "unpublished" && (
                <Button variant="secondary" onClick={onPublish} disabled={busy || dirty}>
                  Publish
                </Button>
              )}
              {access === "manage" && status === "published" && (
                <Button variant="secondary" onClick={onUnpublish} disabled={busy || dirty}>
                  Unpublish
                </Button>
              )}
              {status === "published" && (
                <>
                  <Button variant="secondary" disabled aria-describedby={reviewHint}>
                    Review a contract
                  </Button>
                  <span id={reviewHint} className="text-caption text-fg-muted">
                    Reviewing a contract against this playbook is coming soon.
                  </span>
                </>
              )}
              {dirty && access === "manage" && (
                <span className="text-caption text-fg-muted">Save before publishing.</span>
              )}
            </div>
          )}
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          {!clean && !readOnly && (
            <ul className="text-caption text-destructive">
              {problems.playbook.map((p) => (
                <li key={p}>{p}</li>
              ))}
              {Object.keys(problems.rules).length > 0 && (
                <li>Some rules need attention before you can save.</li>
              )}
            </ul>
          )}
        </header>

        <section aria-label="Playbook details" className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            {(props) => (
              <Input
                {...props}
                value={draft.name}
                maxLength={200}
                readOnly={readOnly}
                onChange={(e) => onChange({ ...draft, name: e.target.value })}
              />
            )}
          </Field>
          <Field label="Contract type">
            {(props) => (
              <Input
                {...props}
                value={draft.contract_type}
                maxLength={100}
                readOnly={readOnly}
                onChange={(e) => onChange({ ...draft, contract_type: e.target.value })}
              />
            )}
          </Field>
          <Field
            label="Global guidance"
            hint="Applies to every rule: who we are, whose paper, how hard to push."
            className="sm:col-span-2"
          >
            {(props) => (
              <Textarea
                {...props}
                value={draft.guidance}
                maxLength={8000}
                readOnly={readOnly}
                onChange={(e) => onChange({ ...draft, guidance: e.target.value })}
              />
            )}
          </Field>
        </section>

        <section aria-labelledby="playbook-rules" className="grid gap-3">
          <div className="flex items-center justify-between gap-2">
            <h2 id="playbook-rules" className="text-section font-semibold">
              Rules ({draft.rules.length})
            </h2>
            {!readOnly && (
              <Button variant="secondary" size="sm" onClick={add} disabled={full}>
                <Plus aria-hidden />
                Add rule
              </Button>
            )}
          </div>
          {draft.rules.length === 0 ? (
            <p className="text-fg-muted">No rules yet. Add the first position you check for.</p>
          ) : (
            <ol className="grid gap-2">
              {draft.rules.map((rule, index) => (
                <RuleEditor
                  key={rule.key}
                  rule={rule}
                  index={index}
                  count={draft.rules.length}
                  expanded={open.has(rule.key)}
                  onToggle={() => toggle(rule.key)}
                  onChange={(next) =>
                    setRules(draft.rules.map((r) => (r.key === rule.key ? next : r)))
                  }
                  onMove={(to) => setRules(moveRule(draft.rules, index, to))}
                  onRemove={() => setRules(draft.rules.filter((r) => r.key !== rule.key))}
                  problems={readOnly ? {} : (problems.rules[rule.key] ?? {})}
                  readOnly={readOnly}
                />
              ))}
            </ol>
          )}
        </section>
      </div>
      {aside && <aside className="min-w-0">{aside}</aside>}
    </div>
  );
}

export function PlaybookBuilderSkeleton() {
  return (
    <div aria-busy="true" className="grid gap-6">
      <span className="sr-only">Loading the playbook…</span>
      <div aria-hidden className="grid gap-2">
        <Skeleton className="h-7 w-72" />
        <Skeleton className="h-5 w-96" />
        <Skeleton className="h-8 w-48" />
      </div>
      <div aria-hidden className="grid gap-3 sm:grid-cols-2">
        <Skeleton className="h-14" />
        <Skeleton className="h-14" />
        <Skeleton className="h-24 sm:col-span-2" />
      </div>
      <div className="grid gap-2">
        <RuleEditorSkeleton />
        <RuleEditorSkeleton />
        <RuleEditorSkeleton />
      </div>
    </div>
  );
}
