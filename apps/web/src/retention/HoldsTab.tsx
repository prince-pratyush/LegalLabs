import { Button, ConfirmDialog, Field, Input, NativeSelect } from "@legallabs/ui";
import { type FormEvent, useState } from "react";
import { Panel, useLoad, when } from "../admin/load.js";
import { Card, Nothing, Table } from "../command-center/parts.js";
import { matterApi } from "../matters/api.js";
import { vaultApi } from "../vaults/api.js";
import { type Hold, type HoldType, retentionApi } from "./api.js";
import { useStepUp } from "./StepUp.js";
import { TargetPicker } from "./Targets.js";

export const TYPE_LABEL: Record<HoldType, string> = {
  matter: "Matter",
  vault: "Vault",
  document: "File",
  thread: "Thread",
  review_table: "Review table",
};

/** Names for what the hold list only identifies by id; missing ones show the id. */
async function names() {
  const [vaults, matters] = await Promise.all([
    vaultApi.adminList().catch(() => []),
    matterApi.list().catch(() => []),
  ]);
  return new Map<string, string>([
    ...vaults.map((v) => [v.id, v.name] as const),
    ...matters.map((m) => [m.id, m.matter_name] as const),
  ]);
}

export function HoldsTab() {
  const holds = useLoad(retentionApi.holds, []);
  const known = useLoad(names, []);
  const stepUp = useStepUp();
  const lift = (h: Hold) =>
    stepUp.run(
      () => retentionApi.setHold({ object_type: h.objectType, object_id: h.objectId, held: false }),
      holds.reload,
    );
  return (
    <div className="grid gap-4">
      <Card title="Legal holds">
        <p className="text-dense text-fg-muted">
          A held item is skipped by retention and can't be purged. A hold on a vault or matter
          covers what is in it.
        </p>
        <Panel state={holds}>
          {(rows) =>
            rows.length === 0 ? (
              <Nothing>Nothing is under a legal hold.</Nothing>
            ) : (
              <Table
                label="Legal holds"
                head={["Type", "Item", "Reason", "Placed", ""]}
                rows={rows.map((h) => ({
                  key: h.id,
                  cells: [
                    TYPE_LABEL[h.objectType],
                    known.data?.get(h.objectId) ?? h.objectId,
                    h.reason,
                    when(h.setAt),
                    <ConfirmDialog
                      key="lift"
                      trigger={
                        <Button variant="quiet" size="sm">
                          Lift
                        </Button>
                      }
                      title="Lift this hold?"
                      description="The item can then expire under its retention policy, at the next hourly sweep if it is already due."
                      confirmLabel="Lift hold"
                      destructive
                      onConfirm={() => lift(h)}
                    />,
                  ],
                }))}
              />
            )
          }
        </Panel>
        {stepUp.prompt}
      </Card>
      <PlaceHold onPlaced={holds.reload} />
    </div>
  );
}

function PlaceHold({ onPlaced }: { onPlaced: () => void }) {
  const [type, setType] = useState<HoldType>("matter");
  const [id, setId] = useState("");
  const [reason, setReason] = useState("");
  const stepUp = useStepUp();
  const picked = type === "matter" || type === "vault";
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void stepUp.run(
      () =>
        retentionApi.setHold({
          object_type: type,
          object_id: id.trim(),
          held: true,
          reason: reason.trim(),
        }),
      () => {
        setId("");
        setReason("");
        onPlaced();
      },
    );
  };
  return (
    <Card title="Place a hold">
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
        <Field label="What to hold">
          {(props) => (
            <NativeSelect
              {...props}
              value={type}
              onChange={(e) => {
                setType(e.target.value as HoldType);
                setId("");
              }}
            >
              {Object.entries(TYPE_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        {picked ? (
          <TargetPicker key={type} kind={type} value={id} onChange={setId} />
        ) : (
          <Field label={`${TYPE_LABEL[type]} ID`} hint="The ID in its address.">
            {(props) => <Input {...props} value={id} onChange={(e) => setId(e.target.value)} />}
          </Field>
        )}
        <Field label="Reason">
          {(props) => (
            <Input
              {...props}
              value={reason}
              maxLength={500}
              onChange={(e) => setReason(e.target.value)}
            />
          )}
        </Field>
        <Button type="submit" size="sm" disabled={!id.trim() || !reason.trim() || stepUp.busy}>
          Place hold
        </Button>
      </form>
      {stepUp.prompt}
    </Card>
  );
}
