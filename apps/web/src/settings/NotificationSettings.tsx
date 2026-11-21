import {
  CATEGORY_LABELS,
  type CategorySetting,
  type EmailMode,
  type NotificationSettings as Settings,
} from "@legallabs/contracts";
import { Button, Checkbox, Field, Input, toast } from "@legallabs/ui";
import { Lock } from "lucide-react";
import { useEffect, useState } from "react";
import { messageOf } from "../api.js";
import { notificationsApi } from "../notifications/api.js";

const MODES: { value: EmailMode; label: string }[] = [
  { value: "action_only", label: "Action required only" },
  { value: "all", label: "Every event" },
];

const zone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

/** Which categories email you, and when to stay quiet. */
export function NotificationSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    notificationsApi.settings().then(setSettings, (err) => setError(messageOf(err)));
  }, []);

  const change = (category: CategorySetting["category"], value: boolean, mode?: EmailMode) =>
    notificationsApi
      .patchSettings({ categories: [{ category, value, ...(mode ? { mode } : {}) }] })
      .then(setSettings, (err) => toast.error(messageOf(err)));

  if (error) return <p role="alert">{error}</p>;
  if (!settings) return <p role="status">Loading email notification settings</p>;

  return (
    <div className="grid max-w-2xl gap-6">
      <section className="grid gap-3" aria-labelledby="email-heading">
        <h2 id="email-heading" className="text-section font-semibold">
          Email notifications
        </h2>
        <p className="text-dense text-fg-muted">
          Choose which kinds of activity send you an email. Everything also shows in the
          notifications panel.
        </p>
        <ul className="grid gap-2" aria-label="Email categories">
          {settings.categories.map((c) => {
            const name = CATEGORY_LABELS[c.category];
            return (
              <li
                key={c.category}
                className="flex flex-wrap items-center gap-3 rounded-md border border-border p-3"
              >
                <Checkbox
                  aria-label={`Email for ${name}`}
                  checked={c.effective}
                  disabled={c.locked}
                  onCheckedChange={(value) => change(c.category, value === true)}
                />
                <div className="grid min-w-0 flex-1">
                  <span className="text-ui font-medium">{name}</span>
                  {c.locked && (
                    <span className="flex items-center gap-1 text-caption text-fg-muted">
                      <Lock aria-hidden className="size-3" />
                      Set by your workspace admin; you can't change this.
                    </span>
                  )}
                </div>
                <select
                  aria-label={`Email mode for ${name}`}
                  className="h-8 rounded-md border border-control bg-bg-raised px-2 text-ui text-fg disabled:opacity-50"
                  disabled={c.locked || !c.effective}
                  value={c.mode}
                  onChange={(e) => change(c.category, c.effective, e.target.value as EmailMode)}
                >
                  {MODES.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </li>
            );
          })}
        </ul>
        {settings.include_content ? null : (
          <p className="text-caption text-fg-muted">
            Emails carry only titles and links; your workspace hasn't allowed content in emails.
          </p>
        )}
      </section>
      <QuietHours settings={settings} onSaved={setSettings} />
    </div>
  );
}

function QuietHours({ settings, onSaved }: { settings: Settings; onSaved: (s: Settings) => void }) {
  const q = settings.quiet_hours;
  const [on, setOn] = useState(Boolean(q));
  const [from, setFrom] = useState(q?.from ?? "20:00");
  const [to, setTo] = useState(q?.to ?? "07:00");
  const [tz, setTz] = useState(q?.tz ?? zone());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await notificationsApi.patchSettings({
          quiet_hours: on ? { from, to, tz: tz.trim() } : null,
        }),
      );
      toast.success("Quiet hours saved.");
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="grid gap-3" aria-labelledby="quiet-heading">
      <h2 id="quiet-heading" className="text-section font-semibold">
        Quiet hours
      </h2>
      <p className="text-dense text-fg-muted">
        Emails that don't need action wait until quiet hours end. Emails that need your action are
        sent straight away.
      </p>
      <div className="flex items-center gap-2">
        <Checkbox
          id="quiet-on"
          aria-label="Use quiet hours"
          checked={on}
          onCheckedChange={(v) => setOn(v === true)}
        />
        <span className="text-ui">Use quiet hours</span>
      </div>
      {on && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="From">
            {(props) => (
              <Input
                {...props}
                type="time"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            )}
          </Field>
          <Field label="To">
            {(props) => (
              <Input {...props} type="time" value={to} onChange={(e) => setTo(e.target.value)} />
            )}
          </Field>
          <Field label="Time zone" hint="For example Australia/Sydney">
            {(props) => <Input {...props} value={tz} onChange={(e) => setTz(e.target.value)} />}
          </Field>
        </div>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <Button className="justify-self-start" disabled={busy} onClick={save}>
        Save quiet hours
      </Button>
    </section>
  );
}
