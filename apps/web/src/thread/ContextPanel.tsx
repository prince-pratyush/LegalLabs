import { PANEL_MIN, RunProgress, SidePanel } from "@legallabs/ui";
import { type ReactNode, useId, useState } from "react";
import type { Thread } from "../api.js";
import { FileCard } from "./FileCard.js";
import type { LiveRun } from "./run-state.js";

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="grid gap-2">
      <h3 id={id} className="text-ui font-semibold">
        {title}
      </h3>
      {children}
    </section>
  );
}

const plannedSteps = (plan: unknown) => {
  const steps = (plan as { steps?: { id: string; title: string }[] } | null)?.steps;
  return Array.isArray(steps) ? steps : [];
};

/** Where the thread stands: what it is doing, what it made and what it reads. */
export function ContextPanel({
  thread,
  live,
  vaultName,
  sourceName,
  onClose,
}: {
  thread: Thread;
  live: LiveRun | null;
  vaultName: (id: string) => string;
  sourceName: (id: string) => string;
  onClose: () => void;
}) {
  const [width, setWidth] = useState(PANEL_MIN);
  const plan = plannedSteps(live?.plan ?? thread.runs.at(-1)?.plan);
  const outputs = thread.outputs ?? [];
  const reading = [
    ...thread.documents.map((d) => ({ id: d.id, name: d.name })),
    ...thread.vault_ids.map((id) => ({ id, name: vaultName(id) })),
    ...thread.sources.map((s) => ({ id: s.source_id, name: sourceName(s.source_id) })),
  ];
  const none = (text: string) => <p className="text-dense text-fg-muted">{text}</p>;
  return (
    <SidePanel title="Context" onClose={onClose} width={width} onWidthChange={setWidth}>
      <div className="grid gap-6">
        <Section title="Progress">
          {plan.length > 0 && (
            <ol className="list-decimal pl-5 text-dense">
              {plan.map((step) => (
                <li key={step.id}>{step.title}</li>
              ))}
            </ol>
          )}
          {live && live.steps.length > 0 && <RunProgress steps={live.steps} />}
          {plan.length === 0 && !live?.steps.length && none("Nothing is running.")}
        </Section>
        <Section title="Outputs">
          {outputs.length === 0
            ? none("No files yet.")
            : outputs.map((output) => <FileCard key={output.id} output={output} />)}
        </Section>
        <Section title="Sources">
          {reading.length === 0 ? (
            none("Nothing attached.")
          ) : (
            <ul className="grid gap-1 text-dense">
              {reading.map((item) => (
                <li key={item.id} className="truncate">
                  {item.name}
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </SidePanel>
  );
}
