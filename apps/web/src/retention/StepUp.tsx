import { Button, Field, Input } from "@legallabs/ui";
import { type FormEvent, useCallback, useState } from "react";
import { messageOf, useLoad } from "../admin/load.js";
import { ApiError } from "../api.js";
import { stepUpApi } from "./api.js";

type Change = () => Promise<unknown>;
interface Waiting {
  change: Change;
  done: () => void;
}

const said = (error: unknown) => {
  const code = error instanceof ApiError ? error.code : "";
  if (code === "invalid_code") return "That code didn't work. Try again.";
  if (code === "too_many_attempts") return "Too many attempts. Wait a minute, then try again.";
  return messageOf(error);
};

/**
 * Runs a change; if the server wants a fresh second factor first, shows the prompt and runs
 * the same change once the factor is confirmed. Render `prompt` beside the control.
 */
export function useStepUp() {
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async (change: Change, done: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await change();
      setWaiting(null);
      done();
    } catch (e) {
      if (e instanceof ApiError && e.code === "MFA_REQUIRED") setWaiting({ change, done });
      else {
        setWaiting(null);
        setError(messageOf(e));
      }
    } finally {
      setBusy(false);
    }
  }, []);

  const prompt = waiting ? (
    <Prompt
      onConfirmed={() => run(waiting.change, waiting.done)}
      onCancel={() => setWaiting(null)}
    />
  ) : error ? (
    <p role="alert" className="text-destructive">
      {error}
    </p>
  ) : null;

  return { run, prompt, busy };
}

function Prompt({ onConfirmed, onCancel }: { onConfirmed: () => void; onCancel: () => void }) {
  const factors = useLoad(stepUpApi.factors, []);
  const [recovery, setRecovery] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const passkeys =
    (factors.data?.passkeys.length ?? 0) > 0 &&
    typeof window.PublicKeyCredential?.parseRequestOptionsFromJSON === "function";
  // Someone with only a passkey has no code to type, apart from a recovery code.
  const codeless = factors.data !== null && !factors.data.totp && !recovery;

  const confirm = async (check: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await check();
      onConfirmed();
    } catch (e) {
      setError(said(e));
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const typed = code.trim();
    void confirm(() => (recovery ? stepUpApi.recovery(typed) : stepUpApi.totp(typed)));
  };

  const withPasskey = () =>
    confirm(async () => {
      const { challenge_id, options } = await stepUpApi.passkeyOptions();
      const credential = (await navigator.credentials.get({
        publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options),
      })) as PublicKeyCredential;
      await stepUpApi.passkeyVerify(challenge_id, credential.toJSON());
    });

  return (
    <form
      onSubmit={submit}
      aria-label="Confirm it's you"
      className="grid max-w-md gap-3 rounded-lg border border-accent bg-bg-raised p-4"
    >
      <h3 className="text-section font-semibold">Confirm it's you</h3>
      <p className="text-dense text-fg-muted">
        This change needs your second factor from the last 15 minutes. It is saved as soon as you
        confirm.
      </p>
      {!codeless && (
        <Field label={recovery ? "Recovery code" : "Code from your authenticator app"}>
          {(props) => (
            <Input
              {...props}
              autoFocus
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              minLength={6}
              maxLength={40}
              required
            />
          )}
        </Field>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {!codeless && (
          <Button type="submit" size="sm" disabled={busy}>
            Confirm
          </Button>
        )}
        {passkeys && (
          <Button variant="secondary" size="sm" disabled={busy} onClick={withPasskey}>
            Use a passkey
          </Button>
        )}
        <Button
          variant="quiet"
          size="sm"
          onClick={() => {
            setRecovery(!recovery);
            setCode("");
          }}
        >
          {recovery ? "Use a code or passkey" : "Use a recovery code"}
        </Button>
        <Button variant="quiet" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
