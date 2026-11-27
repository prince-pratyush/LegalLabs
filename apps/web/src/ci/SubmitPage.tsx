import { type CiAgent, CiReviewCreate } from "@legallabs/contracts";
import { Button, EmptyState, Field, Input, NativeSelect, Skeleton } from "@legallabs/ui";
import { type FormEvent, useEffect, useState } from "react";
import { api, type DocumentSummary, messageOf } from "../api.js";
import { ciApi } from "./api.js";
import { goCi } from "./route.js";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Gives a live review agent a contract, with what its assignment rules can match on. */
export function SubmitPage({ agentId: fixed }: { agentId: string | null }) {
  const [agents, setAgents] = useState<CiAgent[] | null>(null);
  const [documents, setDocuments] = useState<DocumentSummary[] | null>(null);
  const [form, setForm] = useState({
    agentId: fixed ?? "",
    versionId: "",
    counterparty: "",
    law: "",
    region: "",
    value: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    ciApi.agents().then(
      (all) => {
        const live = all.filter((a) => a.status === "live");
        setAgents(live);
        setForm((f) => (f.agentId || live.length !== 1 ? f : { ...f, agentId: live[0]?.id ?? "" }));
      },
      (err) => {
        setAgents([]);
        setError(messageOf(err));
      },
    );
    api.documents().then(
      // A Word file is read from the file itself, so it needn't wait for indexing.
      (all) => setDocuments(all.filter((d) => d.status === "indexed" || d.mime === DOCX)),
      (err) => {
        setDocuments([]);
        setError(messageOf(err));
      },
    );
  }, []);

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const fields = {
      ...(form.law.trim() ? { governing_law: form.law.trim() } : {}),
      ...(form.region.trim() ? { counterparty_region: form.region.trim() } : {}),
      ...(form.value.trim() ? { contract_value: Number(form.value) } : {}),
    };
    const input = {
      agent_id: form.agentId,
      document_version_id: form.versionId,
      ...(form.counterparty.trim() ? { counterparty: form.counterparty.trim() } : {}),
      ...(Object.keys(fields).length ? { fields } : {}),
    };
    if (!form.agentId || !form.versionId) return setError("Choose an agent and a contract.");
    if (!CiReviewCreate.safeParse(input).success) return setError("Check the contract value.");
    setBusy(true);
    try {
      const { review_id } = await ciApi.submit(input);
      goCi({ page: "review", reviewId: review_id });
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  };

  if (agents?.length === 0 && !error) {
    return (
      <EmptyState
        title="No live review agent"
        description="Build a review agent and activate it, then give it contracts."
        action={{ label: "Review agents", onClick: () => goCi({ page: "agents" }) }}
      />
    );
  }

  return (
    <form onSubmit={submit} noValidate className="grid max-w-xl content-start gap-4">
      <h1 className="text-title font-semibold">Submit a contract</h1>
      {agents === null || documents === null ? (
        <Skeleton className="h-32" />
      ) : (
        <>
          <Field label="Review agent">
            {(props) => (
              <NativeSelect {...props} value={form.agentId} onChange={set("agentId")}>
                <option value="">Choose an agent</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field label="Contract">
            {(props) => (
              <NativeSelect {...props} value={form.versionId} onChange={set("versionId")}>
                <option value="">Choose a document</option>
                {documents.map((d) => (
                  <option key={d.id} value={d.version_id}>
                    {d.name}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field label="Counterparty">
            {(props) => (
              <Input
                {...props}
                value={form.counterparty}
                maxLength={200}
                onChange={set("counterparty")}
              />
            )}
          </Field>
          <Field label="Governing law" hint="Used by assignment rules that match on it.">
            {(props) => <Input {...props} value={form.law} maxLength={100} onChange={set("law")} />}
          </Field>
          <Field label="Counterparty region">
            {(props) => (
              <Input {...props} value={form.region} maxLength={100} onChange={set("region")} />
            )}
          </Field>
          <Field label="Contract value">
            {(props) => (
              <Input {...props} type="number" min={0} value={form.value} onChange={set("value")} />
            )}
          </Field>
        </>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy} className="justify-self-start">
        Submit for review
      </Button>
    </form>
  );
}
