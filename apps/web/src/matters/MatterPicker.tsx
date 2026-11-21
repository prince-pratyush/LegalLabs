import { ConfirmDialog, Field, NativeSelect } from "@legallabs/ui";
import { useEffect, useState } from "react";
import { type Matter, matterApi, messageOf } from "./api.js";

/**
 * Chooses a matter from those the person may work in. A matter with a notice they haven't
 * acknowledged shows it first, and is only chosen once they acknowledge it.
 */
export function MatterPicker({
  value,
  onChange,
  required = false,
}: {
  value: string | null;
  onChange: (matter: Matter | null) => void;
  required?: boolean;
}) {
  const [matters, setMatters] = useState<Matter[] | null>(null);
  const [pending, setPending] = useState<Matter | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    matterApi.list({ picker: true }).then(
      (items) => live && setMatters(items),
      // No matters to offer is the same as an empty list here.
      () => live && setMatters([]),
    );
    return () => {
      live = false;
    };
  }, []);

  if (matters === null || (matters.length === 0 && !required)) return null;

  const choose = (id: string) => {
    setError(null);
    const matter = matters.find((m) => m.id === id) ?? null;
    if (matter && !matter.acknowledged) setPending(matter);
    else onChange(matter);
  };

  const acknowledge = async () => {
    if (!pending) return;
    try {
      await matterApi.acknowledge(pending.id);
      const seen = { ...pending, acknowledged: true };
      setMatters((list) => list?.map((m) => (m.id === seen.id ? seen : m)) ?? null);
      onChange(seen);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setPending(null);
    }
  };

  return (
    <>
      <Field
        label="Matter"
        {...(required ? { hint: "Your workspace asks for a matter here." } : {})}
        {...(error ? { error } : {})}
      >
        {(props) => (
          <NativeSelect
            {...props}
            value={value ?? ""}
            required={required}
            onChange={(e) => choose(e.target.value)}
          >
            <option value="">{required ? "Choose a matter" : "No matter"}</option>
            {matters.map((m) => (
              <option key={m.id} value={m.id}>
                {m.display} · {m.matter_name}
              </option>
            ))}
          </NativeSelect>
        )}
      </Field>
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={pending ? `Notice for ${pending.display}` : "Notice"}
        description={<span className="whitespace-pre-wrap">{pending?.notice_md ?? ""}</span>}
        confirmLabel="Acknowledge"
        onConfirm={acknowledge}
      />
    </>
  );
}
