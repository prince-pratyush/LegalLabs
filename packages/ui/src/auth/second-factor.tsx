import { type FormEvent, useState } from "react";
import { Button } from "../components/button.js";
import { Field, Input } from "../components/field.js";
import { ApiError, FALLBACK, type Pending, secondFactorApi } from "./api.js";

const EXPIRED = "That sign-in expired. Sign in again.";

const said = (error: unknown) => {
  // The browser's own refusal: the prompt was cancelled, timed out or found no passkey.
  if (error instanceof DOMException) return "The passkey wasn't used. Try again.";
  const code = error instanceof ApiError ? error.code : "";
  if (code === "invalid_code") return "That didn't work. Try again.";
  if (code === "too_many_attempts") return "Too many attempts. Wait a minute, then try again.";
  return FALLBACK;
};

const passkeysWork = (parse: "parseRequestOptionsFromJSON" | "parseCreationOptionsFromJSON") =>
  typeof window.PublicKeyCredential?.[parse] === "function";

interface Props {
  pending: Pending;
  onSignedIn: () => void;
  /** Back to the password form, saying why if the sign-in was lost. */
  onRestart: (why: string | null) => void;
  /** What to tell someone whose passkey can't be used here. */
  noPasskey?: string;
}

/** One request at a time; a pending sign-in the server no longer knows starts over. */
function useAttempt(onRestart: Props["onRestart"]) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const attempt = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "";
      if (code === "invalid_mfa_token" || code === "already_enrolled") return onRestart(EXPIRED);
      setError(said(e));
    } finally {
      setBusy(false);
    }
  };
  const alert = error ? (
    <p role="alert" className="text-destructive">
      {error}
    </p>
  ) : null;
  return { attempt, alert, busy };
}

function CodeField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label}>
      {(props) => (
        <Input
          {...props}
          autoFocus
          autoComplete="one-time-code"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          minLength={6}
          maxLength={40}
          required
        />
      )}
    </Field>
  );
}

/** The step after the password: show a factor, or set one up when the workspace requires it. */
export function SecondFactor(props: Props) {
  return props.pending.enrol ? <Enrol {...props} /> : <Verify {...props} />;
}

function Verify({
  pending,
  onSignedIn,
  onRestart,
  noPasskey = "This browser can't use your passkey. Use a recovery code, or another browser.",
}: Props) {
  const { attempt, alert, busy } = useAttempt(onRestart);
  const [recovery, setRecovery] = useState(false);
  const [code, setCode] = useState("");
  const { methods } = pending;
  const passkey = methods.includes("passkey") && passkeysWork("parseRequestOptionsFromJSON");
  // Someone with only a passkey has no code to type, apart from a recovery code.
  const codeless = !methods.includes("totp") && !recovery;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void attempt(async () => {
      await secondFactorApi[recovery ? "recovery" : "totp"](code.trim());
      onSignedIn();
    });
  };

  const withPasskey = () =>
    attempt(async () => {
      const { challenge_id, options } = await secondFactorApi.passkeyOptions();
      const credential = (await navigator.credentials.get({
        publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(
          options as PublicKeyCredentialRequestOptionsJSON,
        ),
      })) as PublicKeyCredential;
      await secondFactorApi.passkeyVerify(challenge_id, credential.toJSON());
      onSignedIn();
    });

  return (
    <form onSubmit={submit} aria-label="Second factor" className="grid gap-4">
      <h2 className="text-section font-semibold">Confirm it's you</h2>
      {codeless ? (
        <p className="text-dense text-fg-muted">
          {passkey ? "Use your passkey to finish signing in." : noPasskey}
        </p>
      ) : (
        <CodeField
          key={recovery ? "recovery" : "totp"}
          label={recovery ? "Recovery code" : "Code from your authenticator app"}
          value={code}
          onChange={setCode}
        />
      )}
      {alert}
      <div className="flex flex-wrap gap-2">
        {!codeless && (
          <Button type="submit" disabled={busy}>
            Confirm
          </Button>
        )}
        {passkey && (
          <Button variant="secondary" disabled={busy} onClick={withPasskey}>
            Use a passkey
          </Button>
        )}
        <Button
          variant="quiet"
          onClick={() => {
            setRecovery(!recovery);
            setCode("");
          }}
        >
          {recovery ? "Use a code or passkey" : "Use a recovery code"}
        </Button>
        <Button variant="quiet" onClick={() => onRestart(null)}>
          Back
        </Button>
      </div>
    </form>
  );
}

function Enrol({ onSignedIn, onRestart }: Props) {
  const { attempt, alert, busy } = useAttempt(onRestart);
  const [app, setApp] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  // Recovery codes are shown only now, so the app waits until the person has them.
  const finished = (codes: string[] | null | undefined) =>
    codes?.length ? setRecoveryCodes(codes) : onSignedIn();

  const confirm = (event: FormEvent) => {
    event.preventDefault();
    void attempt(async () => {
      finished((await secondFactorApi.totpConfirm(code.trim())).recovery_codes);
    });
  };

  const withPasskey = () =>
    attempt(async () => {
      const { challenge_id, options } = await secondFactorApi.registerOptions();
      const credential = (await navigator.credentials.create({
        publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(
          options as PublicKeyCredentialCreationOptionsJSON,
        ),
      })) as PublicKeyCredential;
      const done = await secondFactorApi.registerVerify(challenge_id, credential.toJSON());
      finished(done.recovery_codes);
    });

  if (recoveryCodes) {
    return (
      <section aria-labelledby="recovery-heading" className="grid gap-4">
        <h2 id="recovery-heading" className="text-section font-semibold">
          Save your recovery codes
        </h2>
        <p className="text-dense text-fg-muted">
          Each one signs you in once if you lose your second factor. They are not shown again.
        </p>
        <ul aria-label="Recovery codes" className="grid gap-1 font-mono">
          {recoveryCodes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <Button className="justify-self-start" onClick={onSignedIn}>
          I've saved them
        </Button>
      </section>
    );
  }

  return (
    <form onSubmit={confirm} aria-label="Set up a second factor" className="grid gap-4">
      <h2 className="text-section font-semibold">Set up a second factor</h2>
      <p className="text-dense text-fg-muted">
        Your workspace requires one before you can sign in.
      </p>
      {app && (
        <>
          <p className="text-dense">
            Add this key to your authenticator app, then enter the code it shows.
          </p>
          <p className="font-mono break-all" data-testid="totp-secret">
            {app.secret}
          </p>
          <p className="text-dense text-fg-muted break-all">
            Account: {decodeURIComponent(new URL(app.uri).pathname.replace(/^\/+(totp\/)?/, ""))}
          </p>
          <a className="underline" href={app.uri}>
            Open in an authenticator app
          </a>
          <CodeField label="Code from your authenticator app" value={code} onChange={setCode} />
        </>
      )}
      {alert}
      <div className="flex flex-wrap gap-2">
        {app ? (
          <Button type="submit" disabled={busy}>
            Confirm
          </Button>
        ) : (
          <Button
            disabled={busy}
            onClick={() => attempt(async () => setApp(await secondFactorApi.totpBegin()))}
          >
            Use an authenticator app
          </Button>
        )}
        {passkeysWork("parseCreationOptionsFromJSON") && (
          <Button variant="secondary" disabled={busy} onClick={withPasskey}>
            Create a passkey
          </Button>
        )}
        <Button variant="quiet" onClick={() => onRestart(null)}>
          Back
        </Button>
      </div>
    </form>
  );
}
