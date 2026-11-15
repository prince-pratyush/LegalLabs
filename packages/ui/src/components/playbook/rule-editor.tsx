import { PLAYBOOK_LIMITS } from "@legallabs/contracts";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Flag, Plus, Trash2, X } from "lucide-react";
import { useId } from "react";
import { Button } from "../button.js";
import { Checkbox } from "../checkbox.js";
import { Field, Input, Label, Textarea } from "../field.js";
import { Skeleton } from "../status.js";
import { Tooltip } from "../tooltip.js";
import { ProvenanceBadge } from "./badges.js";
import type { EditableRule, RuleProblems } from "./draft.js";

const describeCondition = (rule: EditableRule) => {
  const c = rule.other_condition;
  if (!c) return null;
  switch (c.kind) {
    case "paper":
      return `Only when the paper is ${c.equals === "ours" ? "ours" : "theirs"}.`;
    case "party_role":
      return `Only when we are the ${c.equals}.`;
    case "rule_status":
      return "Only when another rule has a given result.";
    case "jurisdiction":
      return null;
  }
};

/** One rule of a playbook, folded to its title until opened. */
export function RuleEditor({
  rule,
  index,
  count,
  expanded,
  onToggle,
  onChange,
  onMove,
  onRemove,
  problems = {},
  readOnly = false,
}: {
  rule: EditableRule;
  index: number;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  onChange: (rule: EditableRule) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
  problems?: RuleProblems;
  readOnly?: boolean;
}) {
  const bodyId = useId();
  const set = <K extends keyof EditableRule>(key: K, value: EditableRule[K]) =>
    onChange({ ...rule, [key]: value });
  const name = rule.title.trim() || "Untitled rule";
  const condition = describeCondition(rule);
  const hasProblems = Object.keys(problems).length > 0;

  return (
    <li className="rounded-lg border border-border bg-bg-raised">
      <div className="flex items-center gap-1 p-2">
        <Button
          variant="quiet"
          size="sm"
          className="min-w-0 flex-1 justify-start"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={onToggle}
        >
          {expanded ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
          <span className="text-fg-muted">{index + 1}.</span>
          <span className="truncate">{name}</span>
          {rule.flag && (
            <>
              <Flag aria-hidden className="text-flagged" />
              <span className="sr-only">Flagged</span>
            </>
          )}
          {hasProblems && <span className="text-destructive">Needs attention</span>}
        </Button>
        {!readOnly && (
          <>
            <Tooltip content="Move up">
              <Button
                variant="quiet"
                size="icon"
                aria-label={`Move ${name} up`}
                disabled={index === 0}
                onClick={() => onMove(index - 1)}
              >
                <ArrowUp aria-hidden />
              </Button>
            </Tooltip>
            <Tooltip content="Move down">
              <Button
                variant="quiet"
                size="icon"
                aria-label={`Move ${name} down`}
                disabled={index === count - 1}
                onClick={() => onMove(index + 1)}
              >
                <ArrowDown aria-hidden />
              </Button>
            </Tooltip>
            <Tooltip content="Delete rule">
              <Button variant="quiet" size="icon" aria-label={`Delete ${name}`} onClick={onRemove}>
                <Trash2 aria-hidden />
              </Button>
            </Tooltip>
          </>
        )}
      </div>
      {expanded && (
        <div id={bodyId} className="grid gap-3 border-t border-border p-3">
          <ProvenanceBadge provenance={rule.provenance} />
          <Field label="Title" error={problems.title}>
            {(props) => (
              <Input
                {...props}
                value={rule.title}
                maxLength={200}
                readOnly={readOnly}
                onChange={(e) => set("title", e.target.value)}
              />
            )}
          </Field>
          <Field label="Standard position" error={problems.standard_position}>
            {(props) => (
              <Textarea
                {...props}
                value={rule.standard_position}
                maxLength={4000}
                readOnly={readOnly}
                onChange={(e) => set("standard_position", e.target.value)}
              />
            )}
          </Field>
          <FallbackList
            fallbacks={rule.fallbacks}
            readOnly={readOnly}
            onChange={(fallbacks) => set("fallbacks", fallbacks)}
          />
          <Field label="Unacceptable" hint="Language to mark as not acceptable and escalate.">
            {(props) => (
              <Textarea
                {...props}
                value={rule.unacceptable}
                maxLength={4000}
                readOnly={readOnly}
                onChange={(e) => set("unacceptable", e.target.value)}
              />
            )}
          </Field>
          <Field label="Guidance" hint="Why the position matters and when to bend.">
            {(props) => (
              <Textarea
                {...props}
                value={rule.guidance}
                maxLength={4000}
                readOnly={readOnly}
                onChange={(e) => set("guidance", e.target.value)}
              />
            )}
          </Field>
          <Field
            label="Sample language"
            hint="Clause text to propose when this one is missing or must be replaced."
          >
            {(props) => (
              <Textarea
                {...props}
                value={rule.sample_language}
                maxLength={4000}
                readOnly={readOnly}
                onChange={(e) => set("sample_language", e.target.value)}
              />
            )}
          </Field>
          {condition ? (
            <p className="text-ui text-fg-muted">{condition}</p>
          ) : (
            <Field
              label="Applies under"
              hint="Governing law codes, such as US, UK, EU or US-CA. Leave empty for every jurisdiction."
              error={problems.jurisdictions}
            >
              {(props) => (
                <Input
                  {...props}
                  value={rule.jurisdictions}
                  readOnly={readOnly}
                  placeholder="Every jurisdiction"
                  onChange={(e) => set("jurisdictions", e.target.value)}
                />
              )}
            </Field>
          )}
          <div className="flex items-center gap-1">
            <Checkbox
              id={`${bodyId}-flag`}
              checked={rule.flag}
              disabled={readOnly}
              onCheckedChange={(checked) => set("flag", checked === true)}
            />
            <Label htmlFor={`${bodyId}-flag`}>Always show this clause, even when acceptable</Label>
          </div>
        </div>
      )}
    </li>
  );
}

function FallbackList({
  fallbacks,
  onChange,
  readOnly,
}: {
  fallbacks: string[];
  onChange: (fallbacks: string[]) => void;
  readOnly: boolean;
}) {
  const id = useId();
  const full = fallbacks.length >= PLAYBOOK_LIMITS.fallbacks;
  return (
    <fieldset className="grid gap-2">
      <legend className="text-ui font-medium">Fallbacks</legend>
      <p className="text-caption text-fg-muted">
        Positions you can still accept, most preferred first. Up to {PLAYBOOK_LIMITS.fallbacks}.
      </p>
      {fallbacks.length > 0 && (
        <ol className="grid gap-2">
          {fallbacks.map((fallback, i) => (
            // Fallbacks have no identity of their own beyond their place.
            // biome-ignore lint/suspicious/noArrayIndexKey: order is the identity here
            <li key={i} className="flex items-start gap-1">
              <Textarea
                aria-label={`Fallback ${i + 1}`}
                id={`${id}-${i}`}
                className="min-h-14"
                value={fallback}
                maxLength={4000}
                readOnly={readOnly}
                onChange={(e) => onChange(fallbacks.map((f, j) => (j === i ? e.target.value : f)))}
              />
              {!readOnly && (
                <Tooltip content="Remove fallback">
                  <Button
                    variant="quiet"
                    size="icon"
                    aria-label={`Remove fallback ${i + 1}`}
                    onClick={() => onChange(fallbacks.filter((_, j) => j !== i))}
                  >
                    <X aria-hidden />
                  </Button>
                </Tooltip>
              )}
            </li>
          ))}
        </ol>
      )}
      {!readOnly && (
        <Button
          variant="secondary"
          size="sm"
          className="justify-self-start"
          disabled={full}
          onClick={() => onChange([...fallbacks, ""])}
        >
          <Plus aria-hidden />
          Add fallback
        </Button>
      )}
    </fieldset>
  );
}

export function RuleEditorSkeleton() {
  return (
    <div aria-hidden className="flex items-center gap-2 rounded-lg border border-border p-3">
      <Skeleton className="h-5 flex-1" />
      <Skeleton className="size-6" />
      <Skeleton className="size-6" />
    </div>
  );
}
