import { Field, Input, NativeSelect } from "@legallabs/ui";
import { useState } from "react";
import { messageOf, useLoad } from "../admin/load.js";
import { matterApi } from "../matters/api.js";
import { vaultApi } from "../vaults/api.js";

/** Chooses a vault or a matter by name; matters are searched, since there can be thousands. */
export function TargetPicker({
  kind,
  value,
  onChange,
}: {
  kind: "vault" | "matter";
  value: string;
  onChange: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const options = useLoad(async () => {
    if (kind === "vault") {
      return (await vaultApi.adminList())
        .filter((v) => !v.deleted_at)
        .map((v) => ({ id: v.id, label: `${v.name} (${v.owner_email})` }));
    }
    return (await matterApi.list(q.trim() ? { q: q.trim() } : {})).map((m) => ({
      id: m.id,
      label: `${m.client_name}: ${m.matter_name} (${m.matter_number})`,
    }));
  }, [kind, q]);
  return (
    <>
      {kind === "matter" && (
        <Field label="Search matters">
          {(props) => (
            <Input {...props} type="search" value={q} onChange={(e) => setQ(e.target.value)} />
          )}
        </Field>
      )}
      <Field
        label={kind === "vault" ? "Vault" : "Matter"}
        {...(options.error ? { error: messageOf(options.error) } : {})}
      >
        {(props) => (
          <NativeSelect {...props} value={value} onChange={(e) => onChange(e.target.value)}>
            <option value="">Choose…</option>
            {options.data?.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </NativeSelect>
        )}
      </Field>
    </>
  );
}
