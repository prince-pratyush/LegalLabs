import { type WebSearchSettings, webSearchNotice } from "@legallabs/contracts";
import { Button, Checkbox } from "@legallabs/ui";
import { useState } from "react";
import { AdminShell } from "../admin/AdminShell.js";
import { messageOf, Panel, useLoad } from "../admin/load.js";
import { request, send } from "../http.js";
import { type Matter, matterApi } from "../matters/api.js";

const load = async () => {
  const settings = await request<WebSearchSettings>("/web-search/settings");
  const matters = settings.can_manage ? await matterApi.list({}) : [];
  return { settings, matters };
};

/** Admin: whether questions may be searched for on the web, and for which matters never. */
export function WebSearchApp({ onLeave }: { onLeave: () => void }) {
  const state = useLoad(load, []);
  const [error, setError] = useState<string | null>(null);

  const change = async (path: string, body: object) => {
    setError(null);
    try {
      await send("PUT", path, body);
      state.reload();
    } catch (err) {
      setError(messageOf(err));
    }
  };

  return (
    <AdminShell
      page="web-search"
      title="Web search"
      note="Off until turned on here. The search service is set by whoever runs this installation."
      onLeave={onLeave}
    >
      {error && (
        <p role="alert" className="mb-4 text-destructive">
          {error}
        </p>
      )}
      <Panel state={state}>
        {({ settings, matters }) => <View settings={settings} matters={matters} change={change} />}
      </Panel>
    </AdminShell>
  );
}

function View({
  settings,
  matters,
  change,
}: {
  settings: WebSearchSettings;
  matters: readonly Matter[];
  change: (path: string, body: object) => void;
}) {
  const { enabled, configured, provider_host: host, can_manage: manage } = settings;
  const kept = new Set(settings.blocked_matter_ids);
  return (
    <div className="grid max-w-prose justify-items-start gap-4">
      <p>{enabled && configured ? "Web search is on." : "Web search is off."}</p>
      {host ? (
        <p className="text-fg-muted">{webSearchNotice(host)}</p>
      ) : (
        <p className="text-fg-muted">
          No search service is set up for this installation, so nothing can be searched.
        </p>
      )}
      {manage && (enabled || configured) && (
        <Button onClick={() => change("/web-search/settings", { enabled: !enabled })}>
          {enabled ? "Turn off web search" : "Turn on web search"}
        </Button>
      )}
      {manage && (
        <fieldset className="grid gap-1">
          <legend className="mb-1 font-semibold">Matters never searched for</legend>
          <p className="text-dense text-fg-muted">
            Questions about a ticked matter, or reading its files, can't use web search.
          </p>
          {matters.length === 0 && <p className="text-dense">There are no matters.</p>}
          {matters.map((matter) => (
            <div key={matter.id} className="flex items-center gap-2">
              <Checkbox
                id={`web-${matter.id}`}
                aria-label={matter.display}
                checked={kept.has(matter.id)}
                onCheckedChange={(next) =>
                  change(`/web-search/matters/${matter.id}`, { blocked: next === true })
                }
              />
              <label htmlFor={`web-${matter.id}`}>{matter.display}</label>
            </div>
          ))}
        </fieldset>
      )}
    </div>
  );
}
