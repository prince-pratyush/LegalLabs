import { Button, Checkbox, Field, Input, toast } from "@legallabs/ui";
import { useState } from "react";
import { messageOf } from "../api.js";
import { memoryApi, PERSONALISE_QUESTIONS } from "./api.js";

export function Personalise({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [proposals, setProposals] = useState<{ text: string; keep: boolean }[] | null>(null);
  const [busy, setBusy] = useState(false);

  const suggest = async () => {
    setBusy(true);
    try {
      const given = Object.fromEntries(Object.entries(answers).filter(([, v]) => v.trim()));
      const out = await memoryApi.personalise(given);
      setProposals(out.map((p) => ({ text: p.text, keep: true })));
    } catch (err) {
      toast.error(messageOf(err));
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    setBusy(true);
    try {
      for (const p of (proposals ?? []).filter((x) => x.keep)) await memoryApi.create(p.text);
      toast.success("Memories saved.");
      setProposals(null);
      setOpen(false);
      setAnswers({});
      onSaved();
    } catch (err) {
      toast.error(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="grid gap-2" aria-labelledby="personalise-heading">
      <h2 id="personalise-heading" className="text-section font-semibold">
        Personalise
      </h2>
      {!open ? (
        <>
          <p className="text-dense text-fg-muted">
            Answer six short questions and confirm the memories we propose.
          </p>
          <Button className="justify-self-start" variant="secondary" onClick={() => setOpen(true)}>
            Start personalising
          </Button>
        </>
      ) : proposals === null ? (
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            suggest();
          }}
        >
          {PERSONALISE_QUESTIONS.map((q) => (
            <Field key={q.key} label={q.label}>
              {(props) => (
                <Input
                  {...props}
                  value={answers[q.key] ?? ""}
                  maxLength={500}
                  onChange={(e) => setAnswers((a) => ({ ...a, [q.key]: e.target.value }))}
                />
              )}
            </Field>
          ))}
          <div className="flex gap-2">
            <Button type="submit" disabled={busy || Object.values(answers).every((v) => !v.trim())}>
              Suggest memories
            </Button>
            <Button type="button" variant="quiet" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="grid gap-3">
          <p className="text-dense text-fg-muted">
            Keep the ones that are right. Nothing is saved until you confirm.
          </p>
          {proposals.length === 0 ? (
            <p>No memories to propose from those answers.</p>
          ) : (
            <ul className="grid gap-2" aria-label="Proposed memories">
              {proposals.map((p, i) => (
                <li key={p.text} className="flex items-start gap-2">
                  <Checkbox
                    aria-label={`Keep: ${p.text}`}
                    checked={p.keep}
                    onCheckedChange={(v) =>
                      setProposals(
                        (all) =>
                          all?.map((x, j) => (j === i ? { ...x, keep: v === true } : x)) ?? all,
                      )
                    }
                  />
                  <span>{p.text}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-2">
            <Button disabled={busy || !proposals.some((p) => p.keep)} onClick={save}>
              Save selected memories
            </Button>
            <Button variant="quiet" onClick={() => setProposals(null)}>
              Back
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
