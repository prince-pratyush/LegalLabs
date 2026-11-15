import { Globe, Users, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../button.js";
import { Field, Input } from "../field.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../select.js";
import { Skeleton, StatusText } from "../status.js";

export type ShareLevel = "use" | "edit";

export type LibraryShare = {
  principalType: "user" | "group" | "workspace";
  principalId: string;
  label: string;
  level: ShareLevel;
};

export type ShareCandidate = Omit<LibraryShare, "level">;

const LEVELS: { value: ShareLevel; label: string }[] = [
  { value: "use", label: "Can use" },
  { value: "edit", label: "Can edit" },
];

/**
 * Who can use or edit a Library item. Every change is sent whole, so the server
 * decides and the list always shows what was saved.
 */
export function LibraryShareForm({
  shares,
  workspace,
  canShareWorkspace,
  search,
  onChange,
  error,
}: {
  shares: LibraryShare[];
  /** The workspace as a principal, for the "everyone" switch. */
  workspace: ShareCandidate;
  canShareWorkspace: boolean;
  search: (query: string) => Promise<ShareCandidate[]>;
  onChange: (next: LibraryShare[]) => void;
  error?: string | null;
}) {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<ShareCandidate[]>([]);
  const everyone = shares.some((s) => s.principalType === "workspace");

  useEffect(() => {
    if (query.trim().length < 2) {
      setFound([]);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      search(query.trim()).then(
        (next) => live && setFound(next),
        () => live && setFound([]),
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, search]);

  const same = (a: ShareCandidate, b: ShareCandidate) =>
    a.principalType === b.principalType && a.principalId === b.principalId;
  const add = (who: ShareCandidate) => {
    setQuery("");
    if (!shares.some((s) => same(s, who))) onChange([...shares, { ...who, level: "use" }]);
  };

  return (
    <div className="grid gap-4">
      <Field label="Add people or groups">
        {(props) => (
          <Input
            {...props}
            value={query}
            placeholder="Type a name or group"
            onChange={(e) => setQuery(e.target.value)}
            maxLength={100}
          />
        )}
      </Field>
      {found.length > 0 && (
        <ul aria-label="Matches" className="grid gap-0.5">
          {found.map((who) => (
            <li key={`${who.principalType}:${who.principalId}`}>
              <Button variant="quiet" size="sm" onClick={() => add(who)}>
                {who.principalType === "group" && <Users aria-hidden className="size-4" />}
                {who.label}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {canShareWorkspace && (
        <Button
          variant="quiet"
          size="sm"
          className="justify-self-start"
          onClick={() =>
            onChange(
              everyone
                ? shares.filter((s) => s.principalType !== "workspace")
                : [...shares, { ...workspace, level: "use" }],
            )
          }
        >
          <Globe aria-hidden className="size-4" />
          {everyone ? "Stop sharing with everyone" : "Share with everyone in the workspace"}
        </Button>
      )}
      {error && <StatusText tone="failed">{error}</StatusText>}
      <section aria-label="Shared with" className="grid gap-1">
        <h3 className="text-dense font-semibold">Shared with</h3>
        {shares.length === 0 ? (
          <p className="text-dense text-fg-muted">Only you, and Library managers, can see this.</p>
        ) : (
          <ul className="grid gap-1">
            {shares.map((share) => (
              <li
                key={`${share.principalType}:${share.principalId}`}
                className="flex items-center gap-2 text-dense"
              >
                <span className="min-w-0 flex-1 truncate">{share.label}</span>
                <Select
                  value={share.level}
                  onValueChange={(level) =>
                    onChange(
                      shares.map((s) =>
                        same(s, share) ? { ...s, level: level as ShareLevel } : s,
                      ),
                    )
                  }
                >
                  <SelectTrigger aria-label={`Access for ${share.label}`} className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LEVELS.map((l) => (
                      <SelectItem key={l.value} value={l.value}>
                        {l.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="quiet"
                  size="sm"
                  aria-label={`Stop sharing with ${share.label}`}
                  onClick={() => onChange(shares.filter((s) => !same(s, share)))}
                >
                  <X aria-hidden className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export function LibraryShareFormSkeleton() {
  return (
    <div role="status" aria-label="Loading who this is shared with" className="grid gap-3">
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-full" />
    </div>
  );
}
