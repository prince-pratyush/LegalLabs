import type { SsoSettings } from "@legallabs/contracts";
import { Button, Checkbox, ConfirmDialog, Field, Input } from "@legallabs/ui";
import { type FormEvent, useState } from "react";
import { AdminShell } from "../admin/AdminShell.js";
import { Panel, useLoad } from "../admin/load.js";
import { useStepUp } from "../retention/StepUp.js";
import { identityApi } from "./api.js";

function Tick({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 text-ui">
      <Checkbox
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(on) => onChange(on === true)}
      />
      {label}
      <p className="col-start-2 text-dense text-fg-muted">{hint}</p>
    </div>
  );
}

function Form({ saved }: { saved: SsoSettings }) {
  const [current, setCurrent] = useState(saved);
  const [issuer, setIssuer] = useState(saved.issuer);
  const [clientId, setClientId] = useState(saved.client_id);
  const [secret, setSecret] = useState("");
  const [scopes, setScopes] = useState(saved.scopes.join(" "));
  const [enabled, setEnabled] = useState(saved.enabled);
  const [link, setLink] = useState(saved.link_by_email);
  const [mfa, setMfa] = useState(saved.require_mfa_claim);
  const [asking, setAsking] = useState(false);
  const [done, setDone] = useState(false);
  const { run, prompt, busy } = useStepUp();
  const locked = !current.can_change;

  const save = () => {
    setDone(false);
    let result: SsoSettings;
    void run(
      async () => {
        result = await identityApi.save({
          issuer: issuer.trim(),
          client_id: clientId.trim(),
          ...(secret ? { client_secret: secret } : {}),
          scopes: scopes.split(/\s+/).filter(Boolean),
          enabled,
          link_by_email: link,
          require_mfa_claim: mfa,
        });
      },
      () => {
        setCurrent(result);
        setSecret("");
        setDone(true);
      },
    );
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    // Turning it on changes how everyone but administrators gets in, so it is asked first.
    if (enabled && !current.enabled) setAsking(true);
    else save();
  };

  const field = (
    label: string,
    value: string,
    set: (v: string) => void,
    extra: { type?: string; required?: boolean; placeholder?: string } = {},
  ) => (
    <Field label={label}>
      {(p) => (
        <Input
          {...p}
          {...extra}
          autoComplete="off"
          disabled={locked}
          value={value}
          onChange={(e) => set(e.target.value)}
        />
      )}
    </Field>
  );

  return (
    <div className="grid max-w-2xl gap-4">
      {locked && (
        <p className="text-ui">
          Only an administrator with every permission can change single sign-on.
        </p>
      )}
      {!current.secret_storage && (
        <p className="text-ui">
          This installation has no secret key configured, so a client secret can't be saved. Whoever
          runs it needs to set LEGALLABS_SECRETS_KEY.
        </p>
      )}
      <Field label="Redirect address">
        {(p) => (
          <Input
            {...p}
            readOnly
            value={current.redirect_uri}
            onFocus={(e) => e.currentTarget.select()}
          />
        )}
      </Field>
      <p className="text-dense text-fg-muted">
        Register this with your identity provider as an OpenID Connect web application using the
        authorization code flow. A SAML-only provider connects through a broker.
      </p>
      <form onSubmit={submit} className="grid gap-4">
        {field("Issuer", issuer, setIssuer, {
          type: "url",
          required: true,
          placeholder: "https://login.example.com",
        })}
        {field("Client ID", clientId, setClientId, { required: true })}
        {field("Client secret", secret, setSecret, { type: "password" })}
        {current.has_secret && (
          <p className="text-dense text-fg-muted">
            A secret is saved. Leave this empty to keep it.
          </p>
        )}
        {field("Scopes", scopes, setScopes)}
        <Tick
          label="Turn single sign-on on"
          hint="Only administrators with every permission keep password sign-in, as a way back in."
          checked={enabled}
          disabled={locked}
          onChange={setEnabled}
        />
        <Tick
          label="Link accounts by verified email"
          hint="Lets someone you added sign in the first time by matching the provider's verified email. Use only with a provider you control. Without it, nobody new can sign in this way."
          checked={link}
          disabled={locked}
          onChange={setLink}
        />
        <Tick
          label="Require the provider's second factor"
          hint="Refuses a sign-in the provider did not say used a second factor."
          checked={mfa}
          disabled={locked}
          onChange={setMfa}
        />
        {!locked && (
          <Button type="submit" className="justify-self-start" disabled={busy}>
            Save
          </Button>
        )}
      </form>
      {prompt}
      {done && <p role="status">Saved.</p>}
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title="Turn single sign-on on?"
        description="Members stop being able to sign in with a password or passkey. Administrators with every permission keep theirs."
        confirmLabel="Turn on"
        onConfirm={save}
      />
    </div>
  );
}

/** Admin: the identity provider people sign in through. */
export function IdentityApp({ onLeave }: { onLeave: () => void }) {
  const state = useLoad(identityApi.get, []);
  return (
    <AdminShell
      page="identity"
      title="Single sign-on"
      note="People are still added under Users and groups."
      onLeave={onLeave}
    >
      <Panel state={state}>{(settings) => <Form saved={settings} />}</Panel>
    </AdminShell>
  );
}
